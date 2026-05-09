#!/usr/bin/env bash
#
# GoTEE Rust Starter — SD card flasher for USB Armory MK II
#
# Writes bin/trusted_os.imx to an SD card at the i.MX6 BootROM IVT offset
# (byte 1024, i.e. seek=2 bs=512). The card boots directly on the MK II
# with the boot switch set to uSD.
#
# Usage:
#   ./scripts/flash-sd.sh <device-path>
#
#   macOS:   ./scripts/flash-sd.sh /dev/disk4
#   Linux:   ./scripts/flash-sd.sh /dev/sdb
#            ./scripts/flash-sd.sh /dev/mmcblk0
#
# Find the device first:
#   macOS:   diskutil list
#   Linux:   lsblk -o NAME,SIZE,MODEL,TRAN,RM

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
fail() { echo -e "${RED}[x]${NC} $*" >&2; exit 1; }

IMAGE="bin/trusted_os.imx"

# cd to repo root so the relative IMAGE path works from anywhere.
cd "$(dirname "$0")/.."

if [[ $# -ne 1 ]]; then
    echo "Usage: $0 <device-path>" >&2
    echo "  macOS:   $0 /dev/disk4" >&2
    echo "  Linux:   $0 /dev/sdb" >&2
    exit 2
fi

DEV="$1"

if [[ ! -f "$IMAGE" ]]; then
    fail "$IMAGE not found — run 'make imx' first."
fi

IMAGE_BYTES=$(wc -c < "$IMAGE" | tr -d ' ')

OS="$(uname -s)"

case "$OS" in
    Darwin)
        # Accept /dev/diskN, reject partition slices like /dev/disk4s1.
        if [[ ! "$DEV" =~ ^/dev/r?disk[0-9]+$ ]]; then
            fail "Expected /dev/diskN (whole disk, not a partition). Got: $DEV"
        fi
        # Rewrite to raw node (rdiskN) — ~20× faster writes on macOS.
        RAW_DEV="/dev/r${DEV#/dev/}"

        if ! diskutil info "$DEV" &>/dev/null; then
            fail "$DEV not recognized by diskutil — is the SD card inserted?"
        fi

        DEV_SIZE=$(diskutil info "$DEV" | awk -F': *' '/Disk Size/ {print $2; exit}')
        DEV_NAME=$(diskutil info "$DEV" | awk -F': *' '/Device \/ Media Name/ {print $2; exit}')

        info "Target:   $DEV  ($DEV_NAME, $DEV_SIZE)"
        info "Image:    $IMAGE ($IMAGE_BYTES bytes)"
        echo
        warn "This will overwrite bytes 1024..$((1024 + IMAGE_BYTES)) of $DEV."
        read -r -p "Type 'yes' to continue: " reply
        case "$reply" in
            [yY][eE][sS]) ;;
            *) fail "Aborted." ;;
        esac

        info "Unmounting $DEV..."
        diskutil unmountDisk "$DEV"

        info "Writing (this can take 30-60s)..."
        sudo dd if="$IMAGE" of="$RAW_DEV" bs=512 seek=2
        sync
        ;;

    Linux)
        # Accept /dev/sdX or /dev/mmcblkN, reject partitions like /dev/sda1 / /dev/mmcblk0p1.
        if [[ ! "$DEV" =~ ^/dev/(sd[a-z]|mmcblk[0-9]+)$ ]]; then
            fail "Expected /dev/sdX or /dev/mmcblkN (whole disk, not a partition). Got: $DEV"
        fi

        if [[ ! -b "$DEV" ]]; then
            fail "$DEV is not a block device — is the SD card inserted?"
        fi

        IS_REMOVABLE=$(lsblk -bndo RM "$DEV" 2>/dev/null | tr -d ' ')
        if [[ "$IS_REMOVABLE" != "1" ]]; then
            warn "$DEV is not marked removable. If this is your SD card, proceed carefully."
        fi

        DEV_SIZE=$(lsblk -bndo SIZE "$DEV" | awk '{printf "%.1f GB", $1/1024/1024/1024}')
        DEV_NAME=$(lsblk -ndo MODEL "$DEV" | awk '{$1=$1}1')

        info "Target:   $DEV  (${DEV_NAME:-unknown}, $DEV_SIZE)"
        info "Image:    $IMAGE ($IMAGE_BYTES bytes)"
        echo
        warn "This will overwrite bytes 1024..$((1024 + IMAGE_BYTES)) of $DEV."
        read -r -p "Type 'yes' to continue: " reply
        case "$reply" in
            [yY][eE][sS]) ;;
            *) fail "Aborted." ;;
        esac

        # Unmount any auto-mounted partitions. mount reports them as /dev/sda1,
        # /dev/mmcblk0p1 etc.; match both shapes.
        for part in $(lsblk -nlo NAME "$DEV" | tail -n +2); do
            if mountpoint -q "/dev/$part" 2>/dev/null || mount | grep -q "^/dev/$part "; then
                info "Unmounting /dev/$part..."
                sudo umount "/dev/$part" || true
            fi
        done

        info "Writing..."
        sudo dd if="$IMAGE" of="$DEV" bs=512 seek=2 conv=fsync status=progress
        sync
        ;;

    *)
        fail "Unsupported OS: $OS (only Darwin and Linux are handled)."
        ;;
esac

echo
info "Flash complete."
echo
echo "Next steps:"
echo "  1. Set the USB Armory MK II boot switch to the uSD position"
echo "     (towards the SD card slot, away from the USB-C plug)."
echo "  2. Insert the SD card."
echo "  3. Plug the device into USB. It will appear as a network"
echo "     interface (device: 10.0.0.1, host: 10.0.0.2)."
echo "  4. Bring up the host side of the USB link:"
echo "       ./scripts/armory-link.sh"
echo "  5. Smoke-test the bridge:"
echo "       printf '{\"Method\":\"Echo\",\"Input\":\"hi\"}\\n' | nc 10.0.0.1 4000"
