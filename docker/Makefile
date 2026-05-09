# Build recipes for the Trusted OS + Rust applet pipeline.
#
# Invoked from the repo root's Makefile (`make applet`, `make imx` etc.)
# which just delegates here. Also invoked inside the Docker builder
# image to produce `bin/trusted_os.imx`.
#
# All paths in this file are relative to docker/ (where this Makefile
# lives). Build artifacts are written to ../bin/ and ../target/ so the
# repo root exposes stable `bin/` and `target/` directories.

SHELL := /bin/bash

RUST_TARGET   := armv7a-none-eabi
CROSS_COMPILE := arm-none-eabi-

BUILD_TAGS    = usbarmory,linkramsize,linkramstart,semihosting,syscall_nanotime
OS_TEXT_START := 0x90010000

APPLET_ELF   := ../target/$(RUST_TARGET)/release/trusted_applet
APPLET_DEST  := trusted_os/assets/trusted_applet.elf
OS_ELF       := ../bin/trusted_os.elf
OS_IMX       := ../bin/trusted_os.imx

GOENV := GO_EXTLINK_ENABLED=0 CGO_ENABLED=0 GOOS=tamago GOOSPKG=github.com/usbarmory/tamago GOARCH=arm GOARM=7

.PHONY: applet trusted_os imx clean

# Host-side: builds the Rust applet via cargo and drops a copy into
# trusted_os/assets/ so the Go `go:embed` picks it up.
applet:
	@command -v arm-none-eabi-ld >/dev/null 2>&1 || { \
		echo "error: arm-none-eabi-ld not found — needed to link the Rust applet for ARM."; \
		echo "Install ARM binutils (see README.md → Prerequisites):"; \
		echo "  Debian/Ubuntu: sudo apt install binutils-arm-none-eabi"; \
		echo "  Fedora:        sudo dnf install arm-none-eabi-binutils-cs"; \
		echo "  Arch:          sudo pacman -S arm-none-eabi-binutils"; \
		echo "  macOS:         brew install --cask gcc-arm-embedded"; \
		exit 1; \
	}
	cargo build --release
	@mkdir -p $(dir $(APPLET_DEST))
	cp $(APPLET_ELF) $(APPLET_DEST)

# Runs inside the Docker container. Requires the applet ELF to exist at
# trusted_os/assets/ already (the container has no Cargo); ./build.sh
# ensures this by running `make applet` on the host first.
trusted_os:
	@test -f $(APPLET_DEST) || { echo "error: $(APPLET_DEST) missing. Run 'make applet' on the host before invoking this target."; exit 1; }
	@mkdir -p ../bin
	cd trusted_os && $(GOENV) $(TAMAGO) build \
		-tags "$(BUILD_TAGS)" -trimpath \
		-ldflags "-s -w -T $(OS_TEXT_START) -E _rt0_arm_tamago -R 0x1000" \
		-o ../$(OS_ELF) .

imx: trusted_os
	$(CROSS_COMPILE)objcopy -j .text -j .rodata -j .shstrtab -j .typelink \
		-j .itablink -j .gopclntab -j .go.buildinfo -j .go.module \
		-j .noptrdata -j .data \
		-j .bss --set-section-flags .bss=alloc,load,contents \
		-j .noptrbss --set-section-flags .noptrbss=alloc,load,contents \
		$(OS_ELF) -O binary $(OS_ELF).bin
	cp imximage.cfg $(OS_ELF).dcd
	echo "DATA 4 0x020e4024 0x00000001  # TZASC_BYPASS (pre-DDR init)" >> $(OS_ELF).dcd
	mkimage -n $(OS_ELF).dcd -T imximage -e $(OS_TEXT_START) -d $(OS_ELF).bin $(OS_IMX)
	rm -f $(OS_ELF).dcd
	@# mkimage's -e flag writes a literal value to the IVT entry field;
	@# copy the real ELF entry (byte 24 of the ELF header = e_entry) over
	@# it, otherwise the BootROM jumps to garbage and boot hangs silently.
	dd if=$(OS_ELF) of=$(OS_IMX) bs=1 count=4 skip=24 seek=4 conv=notrunc status=none
	rm -f $(OS_ELF).bin

clean:
	cargo clean
	rm -rf ../bin/
	rm -f $(APPLET_DEST)
