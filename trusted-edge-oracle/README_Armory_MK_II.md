# GoTEE Rust Starter

Write Rust code that runs inside ARM TrustZone **Secure World** on a [USB Armory MK II](https://github.com/usbarmory/usbarmory/wiki). The Trusted Computing Base is tiny: your applet is a pure `(method, input) → output` function. Everything else — webservers, UIs, storage — lives outside and calls in when it needs a trusted operation.

## Prerequisites

- USB Armory MK II + a microSD card + a USB-C **data** cable
- [Docker](https://www.docker.com/) (Desktop on Mac, Engine on Linux)
- [Rust](https://rustup.rs/) — the repo pins nightly via `rust-toolchain.toml`
- ARM bare-metal binutils — provides `arm-none-eabi-ld`, the linker Cargo uses for the `armv7a-none-eabi` target. Not bundled with rustup.
  - Debian/Ubuntu: `sudo apt install binutils-arm-none-eabi`
  - Fedora: `sudo dnf install arm-none-eabi-binutils-cs`
  - Arch: `sudo pacman -S arm-none-eabi-binutils`
  - macOS: `brew install --cask gcc-arm-embedded`
- `nc` (BSD netcat) — preinstalled on macOS; `sudo apt install netcat-openbsd` on Debian/Ubuntu
- [Bun](https://bun.sh/) — *optional*, only needed by examples that ship a host-side HTTP shim (e.g. `examples/square/`)

## Quick Start

```bash
# 1. Build the flashable image (~5 min first time, ~30 s thereafter)
./docker/build.sh

# 2. Flash it onto an SD card
./scripts/flash-sd.sh /dev/diskN              # macOS: diskutil list
                                              # Linux: lsblk -o NAME,SIZE,RM

# 3. Insert the SD, set the MK II boot switch to µSD, plug USB into your host.
#    The device appears as a USB CDC-ECM network interface.

# 4. Bring up the host side of the USB link (assigns 10.0.0.2 and primes
#    ARP). Re-run after any device reboot — macOS drops the IP on disconnect.
./scripts/armory-link.sh

# 5. Talk to the default applet
printf '{"Method":"Echo","Input":"hi"}\n' | nc 10.0.0.1 4000
# {"Output":"hi"}
```

That's the whole stack working: your shell → USB CDC-ECM → Trusted OS → Rust applet in Secure World → reply. For a richer demo that wraps the bridge in an HTTP webserver, see [`examples/square/`](examples/square/).

## Writing a trusted function

`src/main.rs` is the only file you edit. Add match arms to `handle` for each trusted operation you want to expose:

```rust
fn handle(method: &str, input: &[u8], out: &mut [u8]) -> usize {
    match method {
        "Echo" => {
            let n = input.len().min(out.len());
            out[..n].copy_from_slice(&input[..n]);
            n
        }
        // "Sign" => { ... gotee_syscall::getrandom(&mut key) ... }
        _ => 0,
    }
}

#[no_mangle]
pub extern "C" fn _start() -> ! {
    gotee_syscall::serve(handle)
}
```

`serve()` long-polls the Trusted OS for the next request, calls `handle`, and ships the reply.

## Hot-swap: change the applet without reflashing

```bash
$EDITOR src/main.rs
make applet
bun run upload target/armv7a-none-eabi/release/trusted_applet
# → ok, rebooting — device comes back up in ~5 s running your new applet
./scripts/armory-link.sh    # re-arm the host IP after the reboot (macOS drops it)
```

`scripts/upload.ts` base64-encodes the ELF and POSTs it to the bridge's `__upload` method. The Trusted OS validates the header, writes it to the SD card past the Trusted OS image, then triggers a watchdog reset. If the new applet is broken, the next boot silently falls back to the embedded default — the device self-recovers.

(The uploader uses Bun because it's a one-file script, but any language that can open a TCP socket works. See the [bridge protocol](#bridge-protocol) below.)

## Bridge protocol

The Trusted OS exposes a single newline-delimited JSON TCP listener on `10.0.0.1:4000`:

```
→ {"Method":"Echo","Input":"hi"}
← {"Output":"hi"}

→ {"Method":"__upload","Input":"<base64 ELF>"}
← {"Output":"ok, rebooting"}
```

Any `Method` other than `__upload` is forwarded verbatim to your applet's `handle()`.

## How it works

```
┌──────────────────────────────────────────────────┐
│               USB Armory MK II                   │
│                                                  │
│  Secure World (TrustZone)                        │
│  ┌────────────────────────────────────────────┐  │
│  │  Trusted OS  (Go/TamaGo, system mode)      │  │
│  │   - Hardware init, syscall dispatch        │  │
│  │   - TCP JSON bridge on :4000 (CDC-ECM)     │  │
│  │   - SSH console on :22                     │  │
│  ├────────────────────────────────────────────┤  │
│  │  Trusted Applet  (Rust, user mode)         │  │
│  │   - YOUR CODE (src/main.rs)                │  │
│  │   - Uses gotee_syscall crate               │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  Normal World: unused in this starter            │
└──────────────────────────────────────────────────┘
```

The **Trusted OS** (`docker/trusted_os/`) is a Go unikernel compiled with [TamaGo](https://github.com/usbarmory/tamago) that runs on bare metal. It sets up hardware, loads your Rust applet, and supervises it.

The **Trusted Applet** (`src/main.rs`) runs in Secure World *user mode* and talks to the Trusted OS via syscalls provided by the `gotee_syscall` crate.

## Project structure

```
gotee_starter/
├── src/main.rs              ← your applet (edit this)
├── examples/
│   ├── blinky/              ← LED control
│   ├── crypto/              ← hardware RNG
│   ├── attestation/         ← remote attestation
│   └── square/              ← x² applet + Bun HTTP shim (own README)
├── scripts/
│   ├── flash-sd.sh          ← SD card flasher (macOS + Linux)
│   ├── armory-link.sh       ← reassigns host IP on the CDC-ECM link
│   └── upload.ts            ← applet uploader (Bun, used for hot-swap)
├── docker/                  ← image-building pipeline (Rust, Go, mkimage)
│   ├── Dockerfile
│   ├── build.sh             ← produces bin/trusted_os.imx
│   ├── Makefile
│   ├── Cargo.toml
│   ├── gotee_syscall/
│   ├── trusted_os/
│   ├── applet.ld
│   └── imximage.cfg
├── Makefile                 ← thin wrapper that delegates to docker/
└── package.json             ← bun run upload
```

The whole image-building pipeline lives in `docker/` so the root stays focused on what you edit: `src/main.rs` + `examples/` + `scripts/`.

## Examples

Copy one over `src/main.rs`, `make applet`, upload. Each example is a complete working applet, driven over the bridge with `nc` (no webserver required).

| Example        | RPC method | Description                                 |
|----------------|------------|---------------------------------------------|
| `blinky/`      | `Blink`    | Blink the board's blue LED N times          |
| `crypto/`      | `Random`   | Return N bytes from the hardware RNG        |
| `attestation/` | `Attest`   | Return a hardware-derived attestation key   |
| `square/`      | `Square`   | `x → x²`, wrapped in a Bun HTTP shim — see [`examples/square/README.md`](examples/square/README.md) |

```bash
printf '{"Method":"Blink","Input":"3"}\n' | nc 10.0.0.1 4000
```

## Testing

Three of the examples have automated tests that run against a physical device and verify behavior without human observation:

```bash
sudo -v                         # prime sudo so the runner can re-arm the host IP between reboots
./scripts/armory-link.sh        # bring up the USB link
bun test                        # ~45 s: uploads each example, runs assertions over the bridge
```

Covered:
- `examples/square/` — arithmetic correctness + i64 saturation
- `examples/crypto/` — RNG output shape + entropy between successive calls
- `examples/attestation/` — DerivedKey format + per-device determinism

Not covered:
- `examples/blinky/` — requires visually watching the blue LED. After running the tests, your `src/main.rs` is whatever the last test wrote there; `git checkout src/main.rs` to restore the starter.

## Syscalls

The `gotee_syscall` crate provides:

| Function                               | Description                               |
|----------------------------------------|-------------------------------------------|
| `serve(handler)`                       | Run the applet dispatch loop              |
| `println!(...)` / `log!(...)`          | Print to the Trusted OS console           |
| `exit()`                               | Terminate the applet                      |
| `nanotime() -> u64`                    | System time in nanoseconds                |
| `getrandom(&mut buf)`                  | Hardware random bytes                     |
| `rpc_request(&data)` / `rpc_response(&mut buf)` | Raw JSON-RPC into the Trusted OS |

## RPC services (Trusted OS → applet)

The applet can call these methods on the Trusted OS:

| Method       | Description                                 |
|--------------|---------------------------------------------|
| `RPC.Echo`   | Returns the input string (diagnostic)       |
| `RPC.LED`    | Controls the blue LED                       |
| `RPC.Attest` | Returns a hardware-derived attestation key  |

## Resources

- [GoTEE](https://github.com/usbarmory/GoTEE) — TEE framework this is built on
- [GoTEE-example](https://github.com/usbarmory/GoTEE-example) — upstream reference
- [TamaGo](https://github.com/usbarmory/tamago) — bare-metal Go for ARM
- [USB Armory Wiki](https://github.com/usbarmory/usbarmory/wiki)
- [Embedded Rust Book](https://docs.rust-embedded.org/book/)

## License

Based on [GoTEE-example](https://github.com/usbarmory/GoTEE-example) by the GoTEE Authors. See `LICENSE`.
