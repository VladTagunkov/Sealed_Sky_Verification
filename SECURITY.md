# Security model

This is a **hackathon starter kit**, not a production trusted-execution platform. The threat model is "developer with the device on their desk, learning TrustZone fundamentals." Many simplifications here would be unacceptable in a deployed product. They are listed here so you know what's missing if you decide to build something serious on top.

## Threat model (what's protected, what isn't)

**Protected**
- The Trusted Applet runs in TrustZone Secure World user mode. Even if a Normal-World OS were added, the applet's text/data live in `0x96000000–0x97FFFFFF` (`docker/trusted_os/mem.go:21-22`), which is outside any Non-Secure memory region.
- Compromised host-side userland tools cannot directly read the applet's memory. They can only call its bridge methods.
- The applet has no filesystem, no networking, and no syscalls beyond the six in `docker/gotee_syscall/src/lib.rs:20-25`. Side-channel surface is minimal.

**Not protected**
- **Physical access to the USB-C port = full control.** Anyone who can plug in can replace the applet via the bridge's `__upload` method. There is no authentication.
- **Physical access to the SD card = full firmware control.** The `.imx` is unsigned (HAB development mode). Replacing the SD with a hostile image is undetectable from inside the running system.
- The Trusted OS itself is trusted. Bugs in Go/TamaGo, GoTEE, the bridge, or our `imximage.cfg` DCD become applet-visible.

## Audit findings

### M-1. Bridge has no authentication

`docker/trusted_os/bridge.go:33-77` exposes a TCP listener on `10.0.0.1:4000`. Anyone reachable on that link (i.e. anyone with USB physical access) can call any method, including:

- `__upload` — replaces the running applet with arbitrary code.
- Any RPC the applet exposes (LEDs, hardware RNG, derived keys, etc.).

**By design** for a hackathon flow that revolves around `bun run upload …`. If you adapt this for any real deployment, add a shared-secret-token check or mTLS *before* the bridge dispatch.

### M-2. SSH server allows passwordless login

`docker/trusted_os/main.go:141` — `ssh.ServerConfig{NoClientAuth: true}`. Today the shell just echoes input (`docker/trusted_os/main.go:175-203`), so functionally it's harmless. It becomes a real exposure the moment someone adds privileged commands to that shell.

### L-3. Applet ELF validation is structural, not semantic

`writeAppletToSD` (`docker/trusted_os/applet_store.go:91-99`) checks:

- ELF magic (`0x7F 'E' 'L' 'F'`)
- 32-bit class
- ARM machine type
- Size ≤ 512 KB

It does **not** verify the entry point lands inside `.text`, that all loadable segments fit within the applet region, or that the binary is signed. A malformed-but-valid-looking ELF can fault at runtime. Mitigation: the boot path falls back to the embedded default applet on any read failure (`docker/trusted_os/main.go:84-91`), so the device self-recovers.

### L-4. Build supply chain has no checksum verification

- `docker/Dockerfile:29` — `wget` from `go.dev` without SHA256 verification.
- `docker/Dockerfile:36` — `git clone --depth 1 -b latest` of TamaGo's `latest` branch (no commit pin → builds aren't reproducible across time).
- `docker/Dockerfile:17-19` — `apt-get install` without version pins.

Cargo and Go *module* dependencies are pinned via lockfiles (`docker/Cargo.lock`, `docker/trusted_os/go.sum`). The image-build step is the supply-chain weak point. Acceptable for a hackathon because compromise requires a coordinated MITM against TLS+go.dev or repo takeover of `usbarmory/tamago-go`. If you fork this for production, pin a TamaGo commit and use `wget --checksum` (or `sha256sum` after download) on the Go tarball.

### L-5. The `.imx` is unsigned (HAB open mode)

NXP HABv4 supports image signing using fuses on the i.MX6ULL. We don't use it — `imx_usb` reports `HAB security state: development mode` during SDP. SD-card-write access means anyone can replace the Trusted OS. Out of scope for a hackathon kit; required reading if you ever deploy.

### L-6. No rate limit on `__upload`

A malicious tool could spam uploads, causing repeated reboots and SD wear. The device's automatic rollback prevents bricking but does not prevent the wear. Out of scope; mitigation would be a token bucket in `docker/trusted_os/bridge.go`.

## What was checked and found OK

- **`scripts/flash-sd.sh`** — regex-validates the device path (rejects partition slices), refuses without `bin/trusted_os.imx`, requires interactive `yes/YES/Yes` confirmation, uses `set -euo pipefail`. No path-injection vector.
- **`scripts/armory-link.sh`** — finds the Armory's interface by hardcoded MAC, never trusts user input for the privileged `sudo ifconfig` call.
- **`scripts/upload.ts`, `scripts/test-helpers.ts`, `examples/square/server.ts`** — all subprocess calls use `Bun.spawn` with array args (no shell interpolation). The one Bun shell template (`Bun.$\`cp examples/${name}/main.rs ...\``) constrains `name` via a TS union type.
- **No secrets in the repo.** `.gitignore` covers `target/`, `bin/`, `*.imx`, `*.bin`, `*.elf`, `node_modules/`, `bun.lock`, `bun.lockb`. Hardcoded MACs are intentional and are USB-link-local — the same across every USB Armory MK II using this codebase.
- **Cargo + Go dependencies are pinned** in `docker/Cargo.lock` and `docker/trusted_os/go.sum`.

## Reporting issues

This is a hackathon starter — no formal security policy. If you find a meaningful vulnerability that affects participants (e.g. a way to brick the device beyond the SD-reflash recovery, or a Trusted-OS escape from a malformed applet), open an issue or pull request.
