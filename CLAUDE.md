# GoTEE Rust Starter — Project Context (for agents)

This file is the canonical context dump for any AI agent helping a hackathon participant debug or extend this repo. It captures architecture, hard-learned gotchas, file:line references, and external resources. **Skim it first** before suggesting changes — many of the obvious-looking simplifications were tried and broke the build in non-obvious ways. The "Hard-won lessons" section near the bottom records each dead end.

---

## TL;DR — what this repo is

A hackathon starter for writing **Rust trusted applets** that run inside ARM TrustZone **Secure World** on a [USB Armory MK II](https://github.com/usbarmory/usbarmory/wiki). The applet is a pure `(method, input) → output` function dispatched over a TCP/JSON bridge on `10.0.0.1:4000` (USB CDC-ECM). The Trusted Computing Base is a Go/TamaGo unikernel + the Rust applet — no Normal World OS.

Single documented workflow:

1. `./docker/build.sh` → produces `bin/trusted_os.imx` (a flashable i.MX6 boot image)
2. `./scripts/flash-sd.sh /dev/diskN` → writes `.imx` to SD at byte 1024 (the i.MX6 BootROM IVT offset)
3. Set MK II boot switch to **uSD**, insert SD, plug USB
4. `./scripts/armory-link.sh` → assigns `10.0.0.2/24` to the host-side CDC-ECM interface, primes ARP
5. Talk: `printf '{"Method":"Echo","Input":"hi"}\n' | nc 10.0.0.1 4000` → `{"Output":"hi"}`

Hot-swap (no reflash): `make applet` → `bun run upload <ELF>` → `./scripts/armory-link.sh`.

---

## Critical first-pass diagnostics (when a user says "it doesn't work")

Always check USB enumeration first via `ioreg` (macOS) before assuming a code bug:

```bash
ioreg -p IOUSB -l | grep -E '"USB Product Name"|"idVendor"|"idProduct"'
```

Three states with three different root causes:

| What you see | What it means | Where to look |
|---|---|---|
| `"SE Blank 6ULL"` (vendor `0x15a2`, product `0x0080`) | Device in **SDP mode** (BootROM SerialDownload). BootROM didn't find a valid image to boot. | Boot switch position, SD card flash offset, IVT structure |
| `"CDC Ethernet (ECM)"` with MAC `1a:55:89:a2:69:42` | Trusted OS booted, USB device-mode came up. | macOS hasn't auto-IP'd the link — run `./scripts/armory-link.sh` |
| **Silent USB** (no Armory device of any kind) | Device powered (or not). **Either no power** (bad cable), **or** the Trusted OS crashed *after* BootROM but *before* `usbarmory.USB1.Start()` | Power/cable, then Trusted OS init code |

Silent ≠ SDP. SDP requires BootROM to actively reject the boot medium and fall back. Silent means firmware ran and didn't re-init USB.

To rule out hardware/cable problems: **pull the SD card**, plug USB. Boot switch on uSD. With no SD, BootROM *must* drop to SDP. If it doesn't, it's the cable, the port, or a USB hub stealing power. We've reproduced this at least once: same Armory worked on a different Mac USB-C port after failing on the first.

`./scripts/armory-link.sh` does the macOS-specific work too — it greps for the Armory MAC `1a:55:89:a2:69:42` (set in `docker/trusted_os/main.go:48-50`) across all `en*` interfaces, reassigns `10.0.0.2/24`, and pings to prime ARP.

---

## Architecture

Three execution contexts in theory, two used here:

1. **Trusted OS** (`docker/trusted_os/*.go`) — Go/TamaGo unikernel in Secure World **system mode**. Owns hardware init, syscall dispatch, the TCP JSON bridge on `10.0.0.1:4000`, and an SSH listener on `:22`. Boots from SD card. Users should NOT modify this.
2. **Trusted Applet** (`src/main.rs`) — Rust `#![no_std]` binary in Secure World **user mode**. The hackathon participant edits this and only this. Talks to the OS via `gotee_syscall`.
3. **Normal World** — unused in this starter. TZASC region restrictions are deliberately *not* set up; see "Hard-won lessons" → "TrustZone config".

The applet runs as a goroutine inside the GoTEE monitor. Each bridge call enqueues a request that the applet dequeues via `RPC.Recv` (long-poll), processes via `handle()`, and replies via `RPC.Send`. See `docker/trusted_os/rpc.go:45-71` for the channels + `CallApplet` and `docker/gotee_syscall/src/lib.rs:151-183` for the applet-side `serve()` loop.

---

## Hardware: USB Armory MK II

- SoC: NXP **i.MX6ULZ** (factory) but our test hardware was reported as `SE Blank 6ULL` by SDP — both i.MX6UL and i.MX6ULL variants exist in the wild and the Trusted OS handles both at `docker/trusted_os/main.go:58-71`.
- Physical **boot switch** on the edge of the board near the SD slot, two positions: `µSD` (toward SD edge) and `eMMC` (toward USB-C edge). Easy to bump accidentally — confirm visually before assuming a software bug.
- BootROM is in mask ROM; it cannot be bricked by anything in this repo.
- **eMMC is intentionally untouched** by everything in this repo. Some upstream USB Armory flows write a bootloader (armory-boot) to eMMC; we don't. Boot switch must be on **µSD**.
- Resources: [USB Armory wiki](https://github.com/usbarmory/usbarmory/wiki), [Mk II introduction](https://github.com/usbarmory/usbarmory/wiki/Mk-II-Introduction), [boot mode docs](https://github.com/usbarmory/usbarmory/wiki/Boot-Modes-(Mk-II)).

### USB enumeration states (referenced above)

- **SDP**: vendor `0x15a2` "Freescale SemiConductor Inc", product `0x0080` "SE Blank 6ULL" (i.MX6ULL) or `0x0080`/`0x0061` etc. on related variants. Device is the BootROM in [Serial Download Protocol mode](https://github.com/usbarmory/usbarmory/wiki/Boot-Modes-(Mk-II)).
- **Trusted OS up**: USB-CDC-ECM Ethernet device. MAC pair from `docker/trusted_os/main.go:48-50`: device side `1a:55:89:a2:69:41`, host side `1a:55:89:a2:69:42`. macOS sees the host-side MAC on the new `enN` interface (CDC-ECM tells the host which MAC to use locally; the device's own MAC is only visible from inside the Armory).

---

## Boot flow (exact sequence)

1. **BootROM** (mask ROM, runs first). Reads boot switch; on `µSD`, looks at SD card byte 1024 for an i.MX **IVT** (Image Vector Table). Tag must be `0xD1`, length `0x0020` (BE), version `0x40`. If invalid, falls back to SDP over USB. ([i.MX6ULL Reference Manual](https://www.nxp.com/webapp/Download?colCode=IMX6ULLRM), chapter 8 "System Boot".)
2. **DCD** (Device Configuration Data, optional but **required for us**). The IVT points at a DCD blob in OCRAM. BootROM executes its register-write directives to bring up the DDR3L controller (we use ~190 register writes + a JEDEC init sequence — see `docker/imximage.cfg`). Without this, our 10.8 MB image has nowhere to land in DRAM and boot hangs silently.
3. **Image load.** BootROM reads `boot_data.length` bytes from SD into memory at `boot_data.start = 0x9000F000`. The 1024-byte preamble (SD bytes 0..1023) is also loaded — it's a no-op padding region.
4. **Jump to entry point.** BootROM jumps to the IVT's `entry` field. We override this post-mkimage to point to the ELF's actual `_rt0_arm_tamago` (see `docker/Makefile:60` — the `dd ... bs=1 count=4 skip=24 seek=4 conv=notrunc` step). Without this, BootROM jumps to a hardcoded `0x90010000` which is the start of `.text` but **not** the runtime entry — silent hang.
5. **TamaGo runtime init**: stack/heap setup, ARM exception vectors, peripheral clocks. Runs the `init()` functions in `docker/trusted_os/main.go:53-77` (memory regions, DMA region, CPU freq, DCP/CAAM key memory, debug-accessory poll with 250 ms timeout).
6. **`main()`** in `docker/trusted_os/main.go:79-107`: prints banner; reads applet ELF from SD (LBA 65536+) or falls back to embedded default; loads applet via `loadApplet()` in `exec.go`; spawns the applet as a goroutine; calls `startNetworking()`.
7. **USB networking up.** `startNetworking` (`main.go:109-138`) creates the `imx-usbnet.Interface`, enables ICMP, opens listeners on `:22` (SSH) and `:4000` (bridge), then `usbarmory.USB1.Start(...)` enumerates as USB-CDC-ECM. From the host, a new `enN` interface appears with MAC `1a:55:89:a2:69:42`.

`./scripts/armory-link.sh` then assigns `10.0.0.2/24` on that interface (macOS doesn't auto-IP the link).

---

## SD card layout

Single SD card, raw blocks (no filesystem):

```
byte 0 .. 1023   : reserved / leftover (BootROM doesn't read this; some preexisting MBR/data may sit here harmlessly)
byte 1024 (= LBA 2)         : i.MX IVT (start of trusted_os.imx)
byte 1024 .. ~10.8 MB        : trusted_os.imx body (DCD + boot_data + .imx payload)
byte ~10.8 MB .. 32 MB - 1   : unused
byte 32 MB (= LBA 65536)     : applet header — magic "GTA1" (4B) + length (u32 LE) + CRC32 (u32 LE)
byte 32 MB + 512 (LBA 65537) : applet ELF payload, padded to 512-byte blocks
```

The 32 MB offset for the applet region is set in `docker/trusted_os/applet_store.go:38-42` (`appletHeaderLBA = 65536`) — picked to leave 32 MB headroom for the Trusted OS image (currently 10.8 MB). **Don't write before byte 1024**: that's where the BootROM expects the IVT.

`scripts/flash-sd.sh` writes the `.imx` with `dd ... bs=512 seek=2 conv=fsync` (Linux) / `bs=512 seek=2` on rdiskN (macOS) — `seek=2 bs=512` = 1024 byte offset.

---

## Memory layout (runtime, ARM physical addresses)

| Region | Address | Size | Notes |
|---|---|---|---|
| Trusted OS text/data | `0x90000000` | 95 MB | `SecureStart` / `SecureSize`, `docker/trusted_os/mem.go:14-15`. Image header lands at `0x9000F400`, text at `0x90010000`. |
| Secure DMA | `0x95F00000` | 1 MB | `SecureDMAStart` / `SecureDMASize`, `mem.go:16-17`. Relocated from default OCRAM so non-Secure code can't snoop DMA. |
| Trusted Applet (physical) | `0x96000000` | 32 MB | `AppletPhysicalStart` + `AppletSize`, `mem.go:21-22`. BEE-encrypted on i.MX6UL (BEE not present on ULL). |
| Trusted Applet (virtual via BEE alias) | `0x10000000` | 32 MB | `AppletVirtualStart`, `mem.go:20`. Applet text starts at `0x10010000` (see `docker/applet.ld`). |
| Non-Secure World | `0x80000000` | 256 MB | `NonSecureStart` / `NonSecureSize`, `mem.go:26-27`. Allocated but unused. |
| OCRAM (BootROM scratch / DCD target) | `0x00900000` | 128 KB on ULL | DCD blob loads here (`0x00910000`) per `imximage.cfg`. |
| DDR | `0x80000000`–`0x9FFFFFFF` | 512 MB | DDR3L brought up by DCD. |

Constants are mirrored in `docker/applet.ld` (Rust linker script) and `docker/Cargo.toml` `[[bin]] path = "../src/main.rs"` (the binary).

---

## Syscall ABI (applet → Trusted OS)

ARM `swi 0` instruction. Register convention:

- `r0` = syscall number (in)
- `r1`–`r3` = arguments (in)
- `r0`, `r1` = return values (out)

| # | Name | Args | Description |
|---|---|---|---|
| 0 | `SYS_EXIT` | none | Terminate applet (does not return) |
| 1 | `SYS_WRITE` | r1 = byte | Write one byte to Trusted OS console (`docker/trusted_os/handler.go`) |
| 2 | `SYS_NANOTIME` | none | Returns ns; r0 = low 32 bits, r1 = high 32 bits |
| 3 | `SYS_GETRANDOM` | r1 = ptr, r2 = len | Fills buffer with hardware-RNG bytes |
| 4 | `SYS_RPC_REQ` | r1 = ptr, r2 = len | Send JSON-RPC request payload to Trusted OS |
| 5 | `SYS_RPC_RES` | r1 = ptr, r2 = len | Read JSON-RPC reply into buffer; returns length in r0 |

Defined in `docker/gotee_syscall/src/lib.rs:20-25` (Rust side) and `docker/trusted_os/handler.go` (Go side). The `swi 0` instruction traps into the GoTEE monitor.

Public Rust API surface (from `docker/gotee_syscall/src/lib.rs`):

| Function | Description |
|---|---|
| `serve(handler: fn(&str, &[u8], &mut [u8]) -> usize) -> !` | Long-poll loop the applet runs forever |
| `exit() -> !` | Terminate cleanly |
| `print(s: &str)` / `write_byte(b: u8)` | Console output |
| `nanotime() -> u64` | Wall-clock ns |
| `getrandom(&mut [u8])` | Hardware RNG fill |
| `rpc_request(&[u8])` / `rpc_response(&mut [u8]) -> usize` | Raw JSON-RPC pair |
| `print!{...}` / `println!{...}` / `log!{...}` macros | Formatted console output (see `lib.rs:281-318`) |
| Panic handler (`lib.rs:335-347`) | Logs PANIC + exits |

---

## Applet dispatch loop

`src/main.rs` defines:

```rust
fn handle(method: &str, input: &[u8], out: &mut [u8]) -> usize { ... }

#[no_mangle]
pub extern "C" fn _start() -> ! {
    gotee_syscall::serve(handle)
}
```

`serve()` (`docker/gotee_syscall/src/lib.rs:151-183`) loops:

1. Send `RPC.Recv` (long-poll); blocks until something is queued.
2. Decode `Method` and `Input` from the JSON-RPC reply.
3. If `Method == "__exit"`, call `exit()` — this is the sentinel for clean termination.
4. Call user `handle(method, input, out)`; the returned `usize` is the number of bytes written to `out`.
5. Send `RPC.Send` with `{"Output": "<utf-8 bytes from out>"}`. The Trusted OS pushes that back to whoever called `CallApplet`.

JSON parsing uses tiny no-alloc helpers (`extract_json_string`, `JsonBuf`) — see `lib.rs:185-260`.

---

## RPC surface (Trusted OS → applet)

Defined in `docker/trusted_os/rpc.go`. The applet calls these via `gotee_syscall::rpc_request` with a JSON-RPC v1.0 payload like `{"method":"RPC.Foo","params":[...],"id":1}` and reads the response with `rpc_response`.

| Method | Signature | Notes |
|---|---|---|
| `RPC.Echo` | `string -> string` | Diagnostic. `rpc.go:20-23`. |
| `RPC.LED` | `LEDStatus -> bool` | Controls blue LED only; white is reserved. `rpc.go:74-90`. |
| `RPC.Attest` | `bool -> AttestationResult` | Hardware key derivation via DCP (i.MX6ULL) or CAAM (i.MX6UL). `rpc.go:100-132`. Deterministic: same input → same output on the same device. |
| `RPC.Recv` | `bool -> AppletCall` | Internal dispatcher. `rpc.go:52-56`. |
| `RPC.Send` | `AppletReply -> bool` | Internal dispatcher. `rpc.go:60-63`. |

`AttestationResult` is a struct `{DerivedKey []byte, Error string}`. Go's `encoding/json` serializes `[]byte` as **base64**, not hex. The Trusted OS returns 16 bytes on i.MX6ULL (DCP, AES block size) or 32 bytes on i.MX6UL (CAAM). On non-native (QEMU), the Error field is set instead.

---

## Bridge protocol (host → Trusted OS)

The Trusted OS exposes a single TCP listener on `10.0.0.1:4000` (`docker/trusted_os/bridge.go:33-43`, with `handleBridgeConn` at `:45-77`). Newline-delimited JSON, one request per line, one reply per line:

```
→ {"Method":"<name>","Input":"<utf-8 string>"}\n
← {"Output":"<utf-8 string>"}\n
   or
← {"Error":"<message>"}\n
   (Output may also be present alongside Error in some failure modes.)
```

Two cases (`bridge.go:57-76`):

1. `Method = "__upload"`: special — Trusted OS base64-decodes `Input`, validates as ELF32/EM_ARM (`docker/trusted_os/applet_store.go:91-135`), writes to SD at byte 32 MB, replies `{"Output":"ok, rebooting"}`, then **immediately triggers a watchdog reset** via `triggerReset()` in `docker/trusted_os/reset.go`. The reset can race past the reply on the wire (we've seen this) — clients should treat empty stdout + nc exit 0 as probable success.
2. Any other `Method`: forwarded verbatim to the applet via `CallApplet(Method, Input)`. The applet's `handle()` decides what to do; unknown methods return 0 bytes → `{"Output":""}`. **This is what `waitForDevice` in the test helpers exploits**: any method probe gets a reply when the applet is alive.

Concurrency: the applet's RPC channels are depth 1 (`rpc.go:46-48`), so concurrent host connections serialize on `CallApplet`.

---

## Hot-swap mechanism

End-to-end:

1. Edit `src/main.rs`. Run `make applet` (host-native, ~1 s incremental). This compiles the Rust applet via Cargo against `docker/Cargo.toml` and copies the ELF into `docker/trusted_os/assets/trusted_applet.elf`.
2. Run `bun run upload <path-to-elf>` (`scripts/upload.ts`). It base64-encodes the ELF and POSTs `{"Method":"__upload","Input":"<base64>"}` to the bridge via a `nc -w 10` subprocess.
3. Trusted OS validates and persists the new ELF to SD at byte 32 MB (`applet_store.go:91-135`).
4. `triggerReset()` fires; device drops off USB.
5. Boot cycle (~5–8 s): BootROM → DCD → Trusted OS comes back up → reads applet from SD region → runs new code.
6. macOS will have **dropped the host-side IP** when USB went away; re-run `./scripts/armory-link.sh` to reassign `10.0.0.2/24`.

If the new applet panics or has a corrupt header on disk, the Trusted OS's boot path silently falls back to the embedded default (`docker/trusted_os/main.go:88-95`). The device always comes back up — no brick path.

---

## Test suite

`bun test` runs three test files against the live device:

- `examples/square/square.test.ts` — `7→49`, `0→0`, `-3→9`, i64 saturation
- `examples/crypto/crypto.test.ts` — output length, hex regex, two calls differ (entropy)
- `examples/attestation/attestation.test.ts` — DerivedKey present, non-zero, deterministic across calls

Each test file uses `beforeAll(() => setupApplet("<name>"), 120_000)` (`scripts/test-helpers.ts`):

1. `cp examples/<name>/main.rs src/main.rs`
2. `make applet` (rebuild + copy to assets)
3. `bun run scripts/upload.ts <elf>` (uploads + triggers reboot)
4. `Bun.sleep(2000)` (let device start rebooting)
5. `rearmLink()` — `sudo -n -v` to refresh credential then run `armory-link.sh`
6. `waitForDevice()` — polls bridge with `__probe` method until any reply lands

Bun's runner runs **test files sequentially in a single process** by default (one beforeAll completes before the next file's begins). Don't pass `--concurrency 1` or any equivalent flag — Bun treats it as a positional filter and skips your tests.

`preflight()` (run inside each test file's `beforeAll`) verifies:
- `sudo -n true` succeeds (credential cached → reruns of `armory-link.sh` won't hang on a password prompt). User must run `sudo -v` once before `bun test`.
- Bridge is reachable at `10.0.0.1:4000` (uses `__probe` method).

If preflight fails, every `beforeAll` produces one clear error message instead of dozens of cryptic timeouts.

---

## Common user issues + fixes

### Symptom → likely cause table

| Symptom | Most likely cause |
|---|---|
| `ioreg` shows `SE Blank 6ULL` | SD not booting. Check switch is on µSD, SD inserted, `.imx` actually written (run `./scripts/flash-sd.sh` again). |
| `ioreg` empty (silent USB) | Power/cable problem **or** firmware crashed post-BootROM. Try: pull SD → expect SDP → if SDP appears, hardware fine, firmware hung; if still silent, swap cable/USB port. |
| CDC-ECM up but `ping 10.0.0.1` goes via internet (TTL ~62) | `enN` has no IP. Run `./scripts/armory-link.sh`. Macs route 10.0.0.1 to default gateway when no local interface owns 10.0.0.0/24. |
| `ping 10.0.0.1` works (TTL=64), but `nc 10.0.0.1 4000` times out | Bridge listener not up. Wait a few seconds after device reboot. |
| `ping` works but `curl http://localhost:3000/...` returns `ECONNREFUSED 10.0.0.1:4000` | Long-running Bun server got wedged from a prior reboot cycle. Kill and restart it. **Or** more recent fix: server.ts already uses the `nc` subprocess workaround — you're hitting an *older* server process. `lsof -ti tcp:3000 \| xargs kill -9 ; bun run examples/square/server.ts`. |
| Tests time out at 60s in beforeAll | Sudo cache expired mid-run, `armory-link.sh` is hanging on a password prompt. Re-run `sudo -v`. (We added `sudo -n -v` priming inside `rearmLink` to detect this and fail fast.) |
| `bun run upload ...` prints `upload failed: nc exited 0` (with empty stdout) | Reply got eaten by the device's `triggerReset()`. **Upload probably succeeded** — check by `nc 10.0.0.1 4000` after a few seconds. We've already relaxed `scripts/upload.ts` to print "ok, probably rebooting" in this case. |
| `make imx` fails with `Error: No BOOT_FROM tag in /dev/null` | mkimage 2026.04+ rejects `-n /dev/null` for imximage. Fixed in `docker/Makefile` by passing `-n bin/imximage.cfg.tmp`. |
| Docker build fails with `go1.X.0 does not meet the minimum bootstrap requirement of go1.24.6` | TamaGo's `latest` branch needs newer bootstrap. Dockerfile pinned to go1.25.1 (`docker/Dockerfile:29`). |
| Docker `tamago-go` build fails with stdlib test failures (`TestCgoLookupPort`) | `all.bash` runs the Go test suite which trips on missing `/etc/services` entries in slim images. Fixed by using `make.bash` instead (`docker/Dockerfile:37`). |

### macOS-specific: ARP and IP staleness

The host-side `enN` interface for the Armory's CDC-ECM:
- Loses its assigned IP every time USB disconnects (every applet hot-swap reboots the Armory). Re-run `armory-link.sh`.
- ARP entries for the device decay quickly when the link is idle. First TCP attempt after a pause sometimes returns `EHOSTUNREACH` even though `ping` and `nc` work. Mitigations already applied:
  - `examples/square/server.ts` and `scripts/upload.ts` shell out to `nc` per call (Bun's `Bun.connect` and `node:net` compat keep process-scoped state that gets wedged across USB cycles — see "Hard-won lessons").
  - `armory-link.sh` ends with a `ping -c 2` to prime ARP.

### Linux-specific

`scripts/armory-link.sh` uses `ip link` and `ip addr add` on Linux (handled in the same script's `case "$OS" in Linux) ...` branch). Same MAC-based interface lookup. Tests on Linux hosts haven't been exercised by the maintainers but the helper is there.

---

## Hard-won lessons (every "obvious" simplification that we tried and broke)

This section captures debugging journeys so an agent doesn't repeat them.

### 1. The `.imx` image will *not* boot without a DCD.

The Trusted OS ELF is ~11 MB after `objcopy -O binary`. The i.MX6ULL BootROM cannot fit anything that big in OCRAM (~128 KB), so the image must be loaded into DDR. DDR is uninitialized at boot — it requires a DCD register-write sequence. Without DCD, BootROM tries to write to dead memory, `imx_usb` reports `err=-7` (USB write timeout), and the device just hangs. The DCD we use is the canonical USB Armory MK II one from `tamago/board/usbarmory/mk2/imximage.cfg` — copy in `docker/imximage.cfg`.

### 2. The DCD also needs `TZASC_BYPASS` disabled.

For Trusted OS images specifically, the upstream GoTEE-example Makefile appends `DATA 4 0x020e4024 0x00000001 # TZASC_BYPASS` to the DCD. We do the same in `docker/Makefile:54`. Without this, DDR is initialized but TZASC blocks Trusted OS access to it. Boot hangs the same way.

### 3. mkimage's `-e` flag does NOT set the IVT entry point to the ELF's `_rt0_arm_tamago`.

It sets it to whatever literal you pass. Go's linker places `_rt0_arm_tamago` somewhere inside `.text`, NOT at `0x90010000`. We post-process the `.imx` with `dd if=$(OS_ELF) of=$(OS_IMX) bs=1 count=4 skip=24 seek=4 conv=notrunc` (`docker/Makefile:60`) — this copies the ELF's `e_entry` field (bytes 24–27 of the ELF header) over the IVT entry field (bytes 4–7 of the `.imx`). Without this, BootROM jumps to `0x90010000` (somewhere mid-`.text`, not the runtime entry) → silent hang. **Symptom is identical to a missing DCD**, which is what made debugging this miserable.

We also pass `-E _rt0_arm_tamago` to the Go linker so the ELF's `e_entry` *is* the runtime entry.

### 4. `objcopy -j` list must include `.go.module` AND must NOT include `.note.*`.

Upstream's exact incantation (`docker/Makefile:47-52`) includes `.go.module` (Go runtime module info — without it, runtime startup hits a half-initialized module table and the boot just stops, no crash, no log). It explicitly **excludes** `.note.go.pvh` / `.note.go.buildid` / `.note.gnu.build-id` because those notes have VMAs *before* `.text` (at `0x9000FF60`-ish, while `.text` is at `0x90010000`); including them would shift the binary layout by ~0xA0 bytes and the IVT entry-point fixup would land at the wrong place.

We tried `objcopy -O binary` (no `-j` filter, include everything) once. It included the notes. Boot was silent because the entry point pointed `0xA0` bytes into garbage. The fix is the explicit `-j` list, which deliberately excludes those notes.

### 5. BUILD_TAGS must include `usbarmory` and `syscall_nanotime`.

`docker/Makefile:16`:
```
BUILD_TAGS = usbarmory,linkramsize,linkramstart,semihosting,syscall_nanotime
```
Without `usbarmory`, board-specific code paths in `tamago/board/usbarmory/mk2` aren't compiled in, USB device-mode init misbehaves. Without `syscall_nanotime`, the applet's `nanotime()` syscall isn't implemented properly. Upstream uses these too.

### 6. Don't call `configureTrustZone()` in `main()` for this starter.

There's a `tz.go` in upstream GoTEE-example that configures TZASC regions and CSU peripheral access. **We deleted ours.** Why: configuring TZASC regions without ALSO marking USB-Secure (CSU access flag) means the Trusted OS itself can't access USB1 registers — boot wedges right when `usbarmory.USB1.Init()` runs. The single-applet starter has no Normal World to isolate from, so just don't touch TZASC. If a future contributor adds a Normal World OS, port `internal/tz.go` from GoTEE-example **wholesale**, including the USB-Secure step.

### 7. Don't write the applet to LBA 0/1 of the SD card.

Original code had `appletHeaderLBA = 0`, `appletBodyLBA = 1`. That collides with the Trusted OS image at byte 1024+ when SD-booting, because applet body up to 512 KB at LBA 1..1024 overwrites the Trusted OS image at LBA 2..21000. First applet upload would corrupt the Trusted OS on disk → next reboot drops to SDP. We moved the applet region to LBA 65536 (byte 32 MB) — past the Trusted OS image with ~3× headroom. See `docker/trusted_os/applet_store.go:38-42`.

### 8. Bun's TCP APIs are unreliable for talking to the Armory.

Both `Bun.connect` (native) and the `node:net` compat shim accumulate process-scoped state that gets wedged after the USB-CDC-ECM link cycles. Symptoms: a long-running Bun server returns `ECONNREFUSED 10.0.0.1:4000` after a hot-swap reboot, even though a **fresh** Bun process can connect to the same address from the same shell. Restarting the server "fixes" it until the next reboot.

We sidestepped this by spawning `nc` per request in `examples/square/server.ts` and `scripts/upload.ts`. `nc` is a fresh process every call, so no cached state. Latency overhead ~20 ms per call; for a hackathon demo it's invisible.

If a contributor wants to revive direct Bun TCP, the failure is reproducible: run `bun run examples/square/server.ts`, hit it, run `bun run upload <elf>` to trigger a reboot, hit the server again — every subsequent call fails until restart.

### 9. macOS routes `10.0.0.0/24` to default gateway when no local interface owns it.

Trap: after a USB disconnect the host-side `enN` loses its IP. `ping 10.0.0.1` from the user's shell still gets a reply — but TTL is ~62 (going to whoever owns 10.0.0.1 upstream), not 64 (direct USB). Always check TTL when "ping works but app fails." `route -n get 10.0.0.1` shows the actual interface. Re-run `armory-link.sh` to fix.

### 10. The Trusted OS's reply to `__upload` can race the watchdog reset.

`bridge.go:67-72` does `enc.Encode(...)` → `conn.Close()` → `triggerReset()`. The reset can fire before the USB-side packet leaves. Clients that strictly check for the `"ok, rebooting"` reply will incorrectly report failure on a successful upload. Treat empty stdout + zero exit code from `nc` as probable success and verify with a probe call after the reboot completes.

### 11. The applet's RPC.Recv long-poll blocks forever if the applet isn't running yet.

After a fresh boot, there's a brief window (seconds) where the bridge is up but the applet hasn't reached its `serve()` loop. `CallApplet` in the bridge will block. `waitForDevice` in `scripts/test-helpers.ts` polls with a 2-second `nc -w 2` timeout to avoid getting stuck.

---

## File inventory (with key references)

### Files users edit
- `src/main.rs` — Trusted Applet entry point. The `handle()` function is what they iterate on.

### Files users may read but shouldn't edit
- `docker/gotee_syscall/src/lib.rs` — Syscall wrappers, `serve()` loop, no-alloc JSON helpers, panic handler, `print!`/`println!`/`log!` macros.
- `docker/applet.ld` — Linker script. Sets text base to `0x10010000` (applet virtual address).
- `docker/.cargo/config.toml` — Cargo target, linker, target-dir override (`../target` so artifacts land at root `target/`).
- `Makefile` — Thin delegator at root: `applet trusted_os imx clean: $(MAKE) -C docker $@`.
- `docker/Makefile` — Real build recipes. `applet` runs cargo + copies asset; `trusted_os` runs TamaGo build; `imx` runs objcopy + DCD-append + mkimage + entry-fixup; `clean` cleans everything.
- `docker/Dockerfile` — debian:bookworm-slim + binutils-arm-none-eabi + u-boot-tools + Go 1.25.1 + TamaGo (built from source via `make.bash`). `WORKDIR /work` (the bind-mounted repo). Multi-arch via `TARGETARCH`.
- `docker/build.sh` — One-shot wrapper: builds image if missing, runs Cargo on host, runs `make imx` inside the container.
- `scripts/flash-sd.sh` — SD flasher with macOS (diskutil + rdiskN) and Linux (lsblk + sdX) branches. Refuses partitions, requires `yes/YES/Yes` confirmation, uses `dd ... bs=512 seek=2`.
- `scripts/armory-link.sh` — Finds the Armory's `enN` by MAC `1a:55:89:a2:69:42`, assigns `10.0.0.2/24`, primes ARP.
- `scripts/upload.ts` — Bun applet uploader. nc-based.
- `scripts/test-helpers.ts` — `callApplet`, `setupApplet`, `waitForDevice`, `rearmLink`, `preflight` for the Bun test suite.

### Files users should not touch
- `docker/trusted_os/main.go` — Hardware init, applet load, USB networking, SSH server.
- `docker/trusted_os/handler.go` — Syscall dispatch (the `swi 0` trap target).
- `docker/trusted_os/exec.go` — Applet ELF loader (uses upstream `armory-boot/exec`).
- `docker/trusted_os/rpc.go` — RPC method definitions exposed to the applet.
- `docker/trusted_os/bridge.go` — TCP/JSON bridge listener on `:4000`.
- `docker/trusted_os/applet_store.go` — SD raw-block read/write for persisted applet ELF (LBA 65536+).
- `docker/trusted_os/reset.go` — `triggerReset` wrapper around `imx6ul.Reset` (watchdog).
- `docker/trusted_os/mem.go` — Memory layout constants + DMA region init.
- `docker/trusted_os/go.mod`, `go.sum` — Go module pinning.
- `docker/imximage.cfg` — DCD: clocks, DDR pinmux, USDHC pinmux, MMDC controller setup, JEDEC sequence. **Don't edit unless you know what you're doing.**

### Examples (edit/copy at will)
- `examples/blinky/main.rs` — `RPC.Blink(N)` toggles blue LED N times. **Not auto-tested** (visual only).
- `examples/crypto/main.rs` — `Random(N)` returns N hardware-RNG bytes hex-encoded.
- `examples/attestation/main.rs` — `Attest()` returns the JSON-RPC reply from `RPC.Attest` raw.
- `examples/square/main.rs` — `Square(x)` returns x² (saturating i64). Has a Bun HTTP shim in `server.ts` and its own `README.md`.
- `examples/<name>/<name>.test.ts` — Bun test files for square / crypto / attestation.

---

## External references (verified URLs)

### USB Armory MK II
- Wiki: <https://github.com/usbarmory/usbarmory/wiki>
- MK II introduction: <https://github.com/usbarmory/usbarmory/wiki/Mk-II-Introduction>
- Boot modes: <https://github.com/usbarmory/usbarmory/wiki/Boot-Modes-(Mk-II)>

### TamaGo (bare-metal Go for ARM)
- Main repo: <https://github.com/usbarmory/tamago>
- Go fork (the compiler we build from source): <https://github.com/usbarmory/tamago-go>
- USB Armory MK II board package: <https://github.com/usbarmory/tamago/tree/master/board/usbarmory/mk2>
- Canonical DCD we use: <https://github.com/usbarmory/tamago/blob/master/board/usbarmory/mk2/imximage.cfg>

### GoTEE
- Framework: <https://github.com/usbarmory/GoTEE>
- Reference example we forked from: <https://github.com/usbarmory/GoTEE-example>
- Specifically the Trusted OS we adapted: <https://github.com/usbarmory/GoTEE-example/tree/master/trusted_os_usbarmory>

### Other USB Armory tooling
- imx_usb_loader (USB Serial Download recovery): <https://github.com/boundarydevices/imx_usb_loader>
- armory-boot (a 2nd-stage bootloader; we don't use it but it's the canonical reference): <https://github.com/usbarmory/armory-boot>
- imx-usbnet (USB CDC-ECM gadget for TamaGo): <https://github.com/usbarmory/imx-usbnet>

### NXP / i.MX
- i.MX6ULL Reference Manual (boot ROM, IVT format, DCD format, SDP protocol): <https://www.nxp.com/webapp/Download?colCode=IMX6ULLRM> (free with NXP login)

### Build / packaging tools
- mkimage (u-boot-tools): <https://docs.u-boot.org/en/latest/build/tools.html#building-u-boot-tools>
- arm-none-eabi-binutils: ships in Debian as `binutils-arm-none-eabi`

### Host-side dev stack
- Bun: <https://bun.sh>, docs: <https://bun.sh/docs>
- Bun TCP API (`Bun.connect`): <https://bun.sh/docs/api/tcp>
- Bun spawn API: <https://bun.sh/docs/api/spawn>
- Bun test runner: <https://bun.sh/docs/cli/test>
- Rustup (for the nightly target): <https://rustup.rs>
- BSD nc man page (macOS pre-installed): `man nc`

### Sister repo we cribbed Docker patterns from
- rpi-experimental (USB Armory + RPi orchestration): `../../rpi-experimental/` in this workspace; their `usbarmory/docker/Dockerfile.gotee` was our reference for the multi-stage Go bootstrap pattern.

---

## Common tasks

### Hot-swap an applet (no Docker needed)
```bash
$EDITOR src/main.rs
make applet
bun run upload target/armv7a-none-eabi/release/trusted_applet
./scripts/armory-link.sh    # macOS dropped en7's IP on the reboot
printf '{"Method":"YourMethod","Input":"data"}\n' | nc 10.0.0.1 4000
```

### Rebuild the Trusted OS (after Go/TamaGo changes)
```bash
./docker/build.sh
./scripts/flash-sd.sh /dev/diskN
# replug device after flash
```

### Add a new Trusted-OS-side RPC method
1. Add a method to the `RPC` struct in `docker/trusted_os/rpc.go` (Go side).
2. From Rust, call it via `gotee_syscall::rpc_request(br#"{"method":"RPC.YourMethod","params":[...],"id":1}"#)` then `rpc_response(&mut buf)`.
3. `./docker/build.sh` + `./scripts/flash-sd.sh` (full reflash, this is a Trusted OS change).

### Add a new bridge method (host-callable applet method)
Just add a `match` arm in `src/main.rs`'s `handle()`. Hot-swap with `make applet` + `bun run upload …`. No Trusted OS rebuild needed.

### Change applet memory size
1. Update `AppletSize` in `docker/trusted_os/mem.go:21`.
2. Update region in `docker/applet.ld` if needed.
3. `./docker/build.sh` + reflash.

### Run all tests
```bash
sudo -v                              # prime sudo (5-min cache)
./scripts/armory-link.sh             # initial link bring-up
bun test                             # ~45 s
```

### Debug a "device not booting" report
1. `ioreg -p IOUSB -l | grep -E '"USB Product Name"|"idVendor"'` — categorize as SDP / CDC-ECM / silent.
2. SDP: try `./scripts/flash-sd.sh` again, verify boot switch on µSD, verify SD inserted.
3. Silent: pull SD; if SDP shows up, hardware OK and firmware is hung; if still silent, swap cable + USB port.
4. CDC-ECM but unreachable: `./scripts/armory-link.sh`; verify `route -n get 10.0.0.1` shows interface = the Armory enN, not en0/en1.

### Recover from a "bricked" SD
There is no brick. Re-flash the SD (`./scripts/flash-sd.sh`) and replug. The BootROM is in mask ROM; nothing in this repo can damage it. Worst case is an SD with a bad image, which falls back to SDP and is recoverable via re-flash.

---

## Security model

See [`SECURITY.md`](SECURITY.md) for the threat model, audit findings, and notes on what's intentionally not protected. The two most important points to know before suggesting changes:

- **The bridge on `10.0.0.1:4000` has no authentication.** Anyone with USB physical access can call any method including `__upload`. By design for a hackathon kit; not safe for real deployment.
- **The `.imx` is unsigned (HAB development mode).** Anyone with SD-card-write access can replace the Trusted OS. The boot switch + flash-protect on the SD are the only physical defenses.

## Project status / version snapshots (2026-04)

- TamaGo: `latest` branch (commit varies). Requires Go 1.24.6+ to bootstrap → we pin go1.25.1 in the Dockerfile.
- Bun: tested with v1.3.9.
- Rust: `rust-toolchain.toml` pins nightly with `armv7a-none-eabi` + `rust-src`.
- Tested host: macOS Apple Silicon (M3 Max). Linux amd64 paths exist in scripts but haven't been exercised by the maintainers.
- Tested device: a real USB Armory MK II (i.MX6ULL variant, reports as "SE Blank 6ULL" in SDP).
