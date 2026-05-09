// Persistent applet storage on the external SD card.
//
// A new applet ELF uploaded over the bridge is written to raw SD blocks
// (not a filesystem) at a fixed, dedicated region. On the next boot, the
// Trusted OS reads that region back and executes it in place of the
// embedded default. If the card is missing, the region is blank, or the
// checksum doesn't match, boot falls back to the embedded default applet.
//
// Layout (uSD / USDHC1):
//
//	LBA 0..65535   : reserved for the Trusted OS .imx image (32 MB).
//	                 The i.MX6 BootROM expects the IVT at byte 1024
//	                 (LBA 2) when booting from uSD, so the applet region
//	                 must sit past the Trusted OS payload.
//	LBA 65536      : header (512 B) — magic "GTA1", u32 length (LE), u32 CRC32 (LE)
//	LBA 65537..N   : ELF payload, padded to a whole block
//
// This is not a filesystem and is not portable across tools. It's the
// minimum scheme that lets the bridge hand the upload off to the bootrom
// without adding a filesystem to the TCB.

package main

import (
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"hash/crc32"

	usbarmory "github.com/usbarmory/tamago/board/usbarmory/mk2"
)

const (
	appletMagic     = "GTA1"
	appletMaxSize   = 512 * 1024 // 512 KB — sized to the applet region in mem.go
	appletBlockSize = 512
	// 32 MB reserved at the start of the SD card for the Trusted OS .imx
	// (current image is ~11 MB; this leaves ~3× headroom for growth).
	appletHeaderLBA = (32 * 1024 * 1024) / appletBlockSize // = 65536
	appletBodyLBA   = appletHeaderLBA + 1
)

// readAppletFromSD returns (elf, true) when the external SD card holds a
// valid uploaded applet. Any failure — missing card, blank region, bad
// magic, bad CRC — is reported as (nil, false); callers are expected to
// fall back to the embedded default.
func readAppletFromSD() ([]byte, bool) {
	sd := usbarmory.SD
	if sd == nil {
		return nil, false
	}
	if err := sd.Detect(); err != nil {
		return nil, false
	}
	if info := sd.Info(); info.BlockSize != appletBlockSize {
		return nil, false
	}

	hdr := make([]byte, appletBlockSize)
	if err := sd.ReadBlocks(appletHeaderLBA, hdr); err != nil {
		return nil, false
	}
	if !bytes.Equal(hdr[:4], []byte(appletMagic)) {
		return nil, false
	}

	length := binary.LittleEndian.Uint32(hdr[4:8])
	want := binary.LittleEndian.Uint32(hdr[8:12])
	if length == 0 || length > appletMaxSize {
		return nil, false
	}

	nBlocks := int((length + appletBlockSize - 1) / appletBlockSize)
	body := make([]byte, nBlocks*appletBlockSize)
	if err := sd.ReadBlocks(appletBodyLBA, body); err != nil {
		return nil, false
	}

	elf := body[:length]
	if crc32.ChecksumIEEE(elf) != want {
		return nil, false
	}
	return elf, true
}

// writeAppletToSD persists a new applet ELF to the SD region. It validates
// that the bytes look like an ELF32 ARM executable and fit within the
// reserved region, then writes the payload before the header so a crash
// mid-write can never leave a valid header pointing at partial data.
func writeAppletToSD(elf []byte) error {
	if len(elf) < 52 {
		return errors.New("applet: too small to be ELF")
	}
	if !bytes.Equal(elf[:4], []byte{0x7f, 'E', 'L', 'F'}) {
		return errors.New("applet: missing ELF magic")
	}
	if elf[4] != 1 {
		return errors.New("applet: not ELFCLASS32")
	}
	if elf[18] != 0x28 {
		return errors.New("applet: not EM_ARM")
	}
	if len(elf) > appletMaxSize {
		return fmt.Errorf("applet: %d bytes exceeds max %d", len(elf), appletMaxSize)
	}

	sd := usbarmory.SD
	if sd == nil {
		return errors.New("applet: no SD controller on this board")
	}
	if err := sd.Detect(); err != nil {
		return fmt.Errorf("applet: SD detect failed: %w", err)
	}
	if info := sd.Info(); info.BlockSize != appletBlockSize {
		return fmt.Errorf("applet: unexpected SD block size %d", info.BlockSize)
	}

	nBlocks := (len(elf) + appletBlockSize - 1) / appletBlockSize
	body := make([]byte, nBlocks*appletBlockSize)
	copy(body, elf)

	hdr := make([]byte, appletBlockSize)
	copy(hdr[0:4], []byte(appletMagic))
	binary.LittleEndian.PutUint32(hdr[4:8], uint32(len(elf)))
	binary.LittleEndian.PutUint32(hdr[8:12], crc32.ChecksumIEEE(elf))

	if err := sd.WriteBlocks(appletBodyLBA, body); err != nil {
		return fmt.Errorf("applet: SD body write: %w", err)
	}
	if err := sd.WriteBlocks(appletHeaderLBA, hdr); err != nil {
		return fmt.Errorf("applet: SD header write: %w", err)
	}
	return nil
}
