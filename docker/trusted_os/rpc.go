// RPC services exposed to the Trusted Applet.
//
// The applet can call these via gotee_syscall::rpc_request() / rpc_response().
// Add your own methods here to extend the applet ↔ OS interface.

package main

import (
	"crypto/aes"
	"errors"

	usbarmory "github.com/usbarmory/tamago/board/usbarmory/mk2"
	"github.com/usbarmory/tamago/soc/nxp/imx6ul"
)

// RPC is the receiver for Trusted Applet ↔ Trusted OS RPC calls.
type RPC struct{}

// Echo returns the input string back to the applet.
func (r *RPC) Echo(in string, out *string) error {
	*out = in
	return nil
}

// AppletCall is a request the Trusted OS hands to the applet via Recv.
//
// Method "__exit" is a sentinel: serve() will call exit() and terminate the
// applet instead of dispatching it to user code.
type AppletCall struct {
	Method string
	Input  string
}

// AppletReply is the payload the applet returns via Send.
type AppletReply struct {
	Output string
}

// Channels that feed the applet dispatch loop.
//
// Anything inside trusted_os that wants to call the applet pushes an
// AppletCall onto appletRequestCh and then reads the reply from
// appletReplyCh. The queues are buffered to depth 1 because the applet runs
// single-threaded: exactly one call is in flight at a time.
var (
	appletRequestCh = make(chan AppletCall, 1)
	appletReplyCh   = make(chan string, 1)
)

// Recv blocks until the Trusted OS has queued a request for the applet.
// Invoked by the applet's serve() loop as `RPC.Recv`.
func (r *RPC) Recv(_ bool, result *AppletCall) error {
	call := <-appletRequestCh
	*result = call
	return nil
}

// Send delivers the applet's reply back to whoever queued the request.
// Invoked by the applet's serve() loop as `RPC.Send`.
func (r *RPC) Send(reply AppletReply, _ *bool) error {
	appletReplyCh <- reply.Output
	return nil
}

// CallApplet is a convenience for other trusted_os code that wants to invoke
// the applet synchronously. Use from a goroutine so the applet (also running
// as a goroutine under the monitor) can pick up the request.
func CallApplet(method, input string) string {
	appletRequestCh <- AppletCall{Method: method, Input: input}
	return <-appletReplyCh
}

// LEDStatus represents an LED state request.
type LEDStatus struct {
	Name string
	On   bool
}

// LED controls the USB Armory blue LED. The white LED is reserved for the
// Secure World.
func (r *RPC) LED(led LEDStatus, _ *bool) error {
	switch led.Name {
	case "blue", "Blue", "BLUE":
		return usbarmory.LED(led.Name, led.On)
	case "white", "White", "WHITE":
		return errors.New("white LED is reserved for Secure World")
	default:
		return errors.New("invalid LED name")
	}
}

// AttestationResult holds a derived key for remote attestation.
type AttestationResult struct {
	DerivedKey []byte
	Error      string
}

// Attest performs hardware key derivation using the on-chip crypto engine.
// This provides a device-unique key that can be used for remote attestation.
func (r *RPC) Attest(_ bool, result *AttestationResult) error {
	if !imx6ul.Native {
		result.Error = "attestation unavailable under emulation"
		return nil
	}

	var k []byte
	var err error

	switch {
	case imx6ul.CAAM != nil:
		imx6ul.CAAM.SetOwner(true)
		k = make([]byte, 32)
		err = imx6ul.CAAM.DeriveKey(make([]byte, 32), k)
	case imx6ul.DCP != nil:
		k, err = imx6ul.DCP.DeriveKey(
			make([]byte, aes.BlockSize),
			make([]byte, aes.BlockSize),
			-1,
		)
	default:
		result.Error = "no crypto engine available"
		return nil
	}

	if err != nil {
		result.Error = err.Error()
	} else {
		result.DerivedKey = k
	}

	return nil
}
