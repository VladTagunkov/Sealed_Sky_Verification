#!/usr/bin/env bash
#
# GoTEE Rust Starter — one-shot build.
#
# Builds the Rust applet on the host (fast), then runs the Trusted OS +
# mkimage pipeline inside a Docker container that has TamaGo preinstalled.
# Output: bin/trusted_os.imx
#
# Usage:
#   ./docker/build.sh
#
# On first run the Docker image is built (~5 min — TamaGo compiles from
# source). Subsequent runs reuse the cached image (~30 s).

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
fail() { echo -e "${RED}[x]${NC} $*" >&2; exit 1; }

IMAGE=gotee-starter-builder

# Run from repo root so relative paths (docker/, bin/, Makefile) resolve.
cd "$(dirname "$0")/.."

command -v docker >/dev/null 2>&1 || fail "docker not installed — install Docker Desktop (Mac) or docker-engine (Linux)."
command -v cargo  >/dev/null 2>&1 || fail "cargo not installed — install via https://rustup.rs (the repo pins nightly via rust-toolchain.toml)."

# arm-none-eabi-ld is the linker Cargo invokes for the armv7a-none-eabi target.
# It's NOT bundled with rustup, so a fresh Linux box without it gets a cryptic
# "linker not found" error mid-cargo-build. Pre-check with a platform-aware hint.
if ! command -v arm-none-eabi-ld >/dev/null 2>&1; then
    case "$(uname -s)" in
        Linux)
            if   command -v apt-get >/dev/null 2>&1; then HINT="sudo apt install binutils-arm-none-eabi"
            elif command -v dnf     >/dev/null 2>&1; then HINT="sudo dnf install arm-none-eabi-binutils-cs"
            elif command -v pacman  >/dev/null 2>&1; then HINT="sudo pacman -S arm-none-eabi-binutils"
            else HINT="install your distro's 'binutils-arm-none-eabi' (or equivalent) package"
            fi ;;
        Darwin)
            HINT="brew install --cask gcc-arm-embedded" ;;
        *)
            HINT="install your platform's 'binutils-arm-none-eabi' (or equivalent) package" ;;
    esac
    fail "arm-none-eabi-ld not found — needed to link the Rust applet for ARM. Fix: $HINT"
fi

info "Building Rust applet on host"
make applet

if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    warn "$IMAGE image not found — building it now (~5 min, one-time)"
    docker build -t "$IMAGE" docker/
fi

info "Running Trusted OS build inside $IMAGE"
docker run --rm \
    -v "$PWD:/work" \
    -w /work \
    -e TAMAGO=/opt/tamago-go/bin/go \
    "$IMAGE" make imx

[[ -f bin/trusted_os.imx ]] || fail "bin/trusted_os.imx was not produced — check errors above."

SIZE=$(wc -c < bin/trusted_os.imx | tr -d ' ')
info "Build complete: bin/trusted_os.imx ($SIZE bytes)"
echo
case "$(uname -s)" in
    Linux)
        echo "Next: find your SD card device, then flash:"
        echo "  lsblk -o NAME,SIZE,RM,MOUNTPOINTS    # SD card has RM=1; usually /dev/sdX or /dev/mmcblkN"
        echo "  ./scripts/flash-sd.sh /dev/sdX"
        ;;
    Darwin)
        echo "Next: find your SD card device, then flash:"
        echo "  diskutil list                        # look for an external/physical disk matching your SD's size"
        echo "  ./scripts/flash-sd.sh /dev/diskN"
        ;;
    *)
        echo "Next: flash to SD with"
        echo "  ./scripts/flash-sd.sh /dev/<your-sd-device>"
        ;;
esac
