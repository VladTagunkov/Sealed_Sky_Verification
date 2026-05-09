# Top-level delegator. The actual build recipes live in docker/Makefile
# (alongside the Rust/Go/mkimage scaffolding) — this wrapper lets users
# keep running `make applet` / `make clean` from the repo root.
#
# For the full Trusted OS image, use ./docker/build.sh (it also builds
# the Docker image the first time). `make imx` works too if you have
# TamaGo + mkimage + arm-none-eabi-binutils installed locally.

.PHONY: applet trusted_os imx clean

applet trusted_os imx clean:
	@$(MAKE) --no-print-directory -C docker $@
