#!/usr/bin/env bash
#
# Bring up the host side of the USB Armory MK II USB-CDC-ECM link.
#
# macOS drops the interface IP every time the Armory reboots (and every
# applet hot-swap reboots the device). This helper finds whichever en*
# carries the Armory's MAC, assigns 10.0.0.2/24, and pings to prime ARP.
#
# Usage:
#   ./scripts/armory-link.sh           # default: 10.0.0.2/24
#   ./scripts/armory-link.sh 10.0.0.5  # custom host-side IP

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[+]${NC} $*"; }
warn() { echo -e "${YELLOW}[!]${NC} $*"; }
fail() { echo -e "${RED}[x]${NC} $*" >&2; exit 1; }

ARMORY_MAC="1a:55:89:a2:69:42"   # hostMAC from docker/trusted_os/main.go
HOST_IP="${1:-10.0.0.2}"
DEVICE_IP="10.0.0.1"

OS="$(uname -s)"
case "$OS" in
    Darwin)
        IFACE=""
        for i in $(ifconfig -l | tr ' ' '\n' | grep "^en"); do
            mac=$(ifconfig "$i" 2>/dev/null | awk '/ether/ {print $2}')
            if [[ "$mac" == "$ARMORY_MAC" ]]; then
                IFACE="$i"
                break
            fi
        done
        [[ -n "$IFACE" ]] || fail "Armory interface not found. Is the device plugged in and CDC-ECM enumerated?"
        info "Found Armory on $IFACE (MAC $ARMORY_MAC)"
        sudo ifconfig "$IFACE" inet "$HOST_IP" netmask 255.255.255.0 up
        ;;
    Linux)
        IFACE=$(ip -o link | awk -v mac="$ARMORY_MAC" 'tolower($0) ~ mac {gsub(":", "", $2); print $2; exit}')
        [[ -n "$IFACE" ]] || fail "Armory interface not found. Is the device plugged in and CDC-ECM enumerated?"
        info "Found Armory on $IFACE (MAC $ARMORY_MAC)"
        sudo ip addr flush dev "$IFACE"
        sudo ip addr add "$HOST_IP/24" dev "$IFACE"
        sudo ip link set "$IFACE" up
        ;;
    *)
        fail "Unsupported OS: $OS"
        ;;
esac

info "Priming ARP..."
ping -c 2 -W 2000 "$DEVICE_IP" >/dev/null 2>&1 || warn "ping to $DEVICE_IP failed — device may still be booting."

info "Link up: $HOST_IP ($IFACE) ↔ $DEVICE_IP (Armory)"
