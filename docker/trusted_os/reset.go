// Platform reset wrapper.
//
// Isolated in its own file so the exact reset mechanism is easy to swap
// (WDOG software reset, SRC register poke, bootrom re-entry, etc.). The
// upload path in bridge.go calls triggerReset after persisting a new
// applet ELF to SD.

package main

import (
	"github.com/usbarmory/tamago/soc/nxp/imx6ul"
)

// triggerReset asserts a cold reset via WDOG1. On real hardware the SoC
// restarts and the bootrom reloads the Trusted OS image; on QEMU the
// behavior depends on the machine model (known uncertainty — see plan).
func triggerReset() {
	imx6ul.Reset()
}
