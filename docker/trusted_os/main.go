// GoTEE Trusted OS for the USB Armory MK II.
//
// Secure World system-mode component: initializes hardware, loads and
// supervises the Rust Trusted Applet, exposes a JSON/TCP bridge and SSH
// server over USB networking (CDC-ECM at 10.0.0.1:4000 and :22).
//
// Users should NOT need to modify this file. Edit src/main.rs instead.

package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	_ "embed"
	"fmt"
	"log"
	"net"
	"os"
	"runtime"
	"time"
	_ "unsafe"

	usbarmory "github.com/usbarmory/tamago/board/usbarmory/mk2"
	"github.com/usbarmory/tamago/dma"
	"github.com/usbarmory/tamago/soc/nxp/imx6ul"

	"github.com/usbarmory/imx-usbnet"

	"golang.org/x/crypto/ssh"
	"golang.org/x/term"
)

// Embed the Rust Trusted Applet ELF built by Cargo.
// The Makefile copies the built binary here before compiling the Trusted OS.
//
//go:embed assets/trusted_applet.elf
var taELF []byte

//go:linkname ramStart runtime/goos.RamStart
var ramStart uint32 = SecureStart

//go:linkname ramSize runtime/goos.RamSize
var ramSize uint32 = SecureSize

const (
	sshPort = 22
	ip      = "10.0.0.1"
	mac     = "1a:55:89:a2:69:41"
	hostMAC = "1a:55:89:a2:69:42"
)

func init() {
	log.SetFlags(log.Ltime)
	log.SetOutput(os.Stdout)

	initMemory()
	dma.Init(SecureDMAStart, SecureDMASize)

	switch imx6ul.Family {
	case imx6ul.IMX6UL:
		imx6ul.SetARMFreq(imx6ul.Freq528)
		imx6ul.CAAM.DeriveKeyMemory = dma.Default()
		imx6ul.BEE.Init()
		defer imx6ul.BEE.Lock()
		if err := imx6ul.BEE.Enable(AppletPhysicalStart, 0); err != nil {
			log.Fatalf("SM could not activate BEE: %v", err)
		}
	case imx6ul.IMX6ULL:
		imx6ul.SetARMFreq(imx6ul.FreqMax)
		imx6ul.DCP.Init()
		imx6ul.DCP.DeriveKeyMemory = dma.Default()
	}

	debugConsole, _ := usbarmory.DetectDebugAccessory(250 * time.Millisecond)
	<-debugConsole
}

func main() {
	log.Printf("%s/%s (%s) • GoTEE Trusted OS (Secure World)",
		runtime.GOOS, runtime.GOARCH, runtime.Version())

	// Prefer a newer applet persisted on SD by the host uploader over the
	// embedded default. The embedded applet is the rescue path: if the SD
	// region is blank or corrupt, the device still boots something.
	appletBytes := taELF
	if elf, ok := readAppletFromSD(); ok {
		log.Printf("SM loaded applet from SD (%d bytes)", len(elf))
		appletBytes = elf
	} else {
		log.Print("SM no applet on SD, using embedded default")
	}

	ta, err := loadApplet(appletBytes)
	if err != nil {
		log.Fatalf("SM failed to load applet: %v", err)
	}

	// Note: TZASC + CSU restrictions (tz.go) are intentionally NOT called
	// here. This starter runs a Trusted Applet in Secure user mode with
	// no Normal-World OS — there is no second world to isolate against,
	// and configuring TZASC without also marking USB as Secure would
	// block the Trusted OS's own USB register access.
	go runApplet(ta, nil)

	startNetworking()
}

func startNetworking() {
	iface := usbnet.Interface{}

	if err := iface.Init(ip, mac, hostMAC); err != nil {
		log.Fatalf("SM could not initialize USB networking: %v", err)
	}

	iface.EnableICMP()

	sshListener, err := iface.ListenerTCP4(sshPort)
	if err != nil {
		log.Fatalf("SM could not create SSH listener: %v", err)
	}

	go startSSH(sshListener)

	bridgeListener, err := iface.ListenerTCP4(bridgePort)
	if err != nil {
		log.Fatalf("SM could not create bridge listener: %v", err)
	}

	go startBridge(bridgeListener)

	usbarmory.USB1.Init()
	usbarmory.USB1.DeviceMode()
	usbarmory.USB1.Reset()

	// Never returns.
	usbarmory.USB1.Start(iface.NIC.Device)
}

func startSSH(listener net.Listener) {
	srv := &ssh.ServerConfig{NoClientAuth: true}

	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		log.Printf("SM SSH key generation failed: %v", err)
		return
	}

	signer, err := ssh.NewSignerFromKey(key)
	if err != nil {
		log.Printf("SM SSH signer creation failed: %v", err)
		return
	}

	log.Printf("SM SSH server started (%s)", ssh.FingerprintSHA256(signer.PublicKey()))
	srv.AddHostKey(signer)

	for {
		conn, err := listener.Accept()
		if err != nil {
			continue
		}

		sshConn, chans, reqs, err := ssh.NewServerConn(conn, srv)
		if err != nil {
			continue
		}

		log.Printf("SM new SSH connection from %s", sshConn.RemoteAddr())
		go ssh.DiscardRequests(reqs)
		go handleSSHChannels(chans)
	}
}

func handleSSHChannels(chans <-chan ssh.NewChannel) {
	for ch := range chans {
		if ch.ChannelType() != "session" {
			ch.Reject(ssh.UnknownChannelType, "unsupported")
			continue
		}

		conn, reqs, err := ch.Accept()
		if err != nil {
			continue
		}

		terminal := term.NewTerminal(conn, "> ")

		go func() {
			defer conn.Close()
			for {
				line, err := terminal.ReadLine()
				if err != nil {
					return
				}
				fmt.Fprintf(terminal, "echo: %s\r\n", line)
			}
		}()

		go func() {
			for req := range reqs {
				if req.Type == "shell" && len(req.Payload) == 0 {
					req.Reply(true, nil)
				}
			}
		}()
	}
}
