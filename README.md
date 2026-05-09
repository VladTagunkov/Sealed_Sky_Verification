# Trusted Edge Oracle + Sealed Sky

This repository combines **two parts** that share branding and navigation but run as **separate apps**. Each part has **its own dev server** — run both in two terminals when you want the full hackathon flow (timelock UI + verification UI).

| Part | What it is | Dev server | Default URL |
|------|------------|------------|-------------|
| **1. Trusted Edge Oracle** | USB Armory signing, Node backend (verify + Sepolia tx), static verification UI, optional ENS publish | **Node** (`backend/server.js`) | **http://localhost:3000** — API + static UI at `/ui/` |
| **2. Sealed Sky** | Vite + React timelock (drand / cTRNG), ENS/NameStone capsules | **Vite** (`sealed-sky-web`) | **http://localhost:5173** |

The the verification UI (`http://localhost:3000/ui/index.html`); the Seal Sky pages can link back to Sealed Sky on port **5173**. If one server is stopped, that navigation target will not load until you start it.

---

## Part 1 — Trusted Edge Oracle (port 3000)

**Flow:** Seal Sky Input → USB `SignInference` → submit proof → backend verifies HMAC → `TrustedEdgeOracle` on Sepolia (if configured) → history JSON → optional NameStone publish.

### Prerequisites (summary)

- USB Armory MK II (for hardware signing) — see **USB Armory & Rust applet** below
- [Bun](https://bun.sh/) — upload script + optional tests
- [Node.js](https://nodejs.org/) — backend
- Backend env: **`RPC_URL`**, **`PRIVATE_KEY`** (relayer wallet on the same chain as [`trusted-edge-oracle`](trusted-edge-oracle/))
- Optional ENS: **`VITE_NAMESTONE_API_KEY`** / **`VITE_NAMESTONE_DOMAIN`** in `sealed-sky-web/_env.local` or `.env.local` (backend loads these for publish); see [`backend/.env.example`](backend/.env.example)

### Run the Oracle backend (required for Part 1 UI + API)

```bash
cd backend
npm install
# Set RPC_URL, PRIVATE_KEY (e.g. in .env — see backend/.env.example)
node server.js
# → http://localhost:3000 — POST /submit, /sign-inference, /history, /publish-validation-ens, /read-validation-ens
# → http://localhost:3000/ui/index.html — Seal Sky Verification Submit Interface
```

After Armory USB is up and `./scripts/armory-link.sh` has been run:

- **Verification UI:** open `frontend/index.html` via the backend (`/ui/`) or from disk (prefer `/ui/` so API origin matches).
- **Generate proof:** `frontend/input.html` (Seal Sky Input) or `/ui/input.html`.
- **History + ENS buttons:** `frontend/history.html` or `/ui/history.html`.

### On-chain contract (Foundry)

Deploy and wire the address into `backend/server.js` as `contractAddress`. Details: **[`trusted-edge-oracle/README.md`](trusted-edge-oracle/README.md)**.

---

## Part 2 — Sealed Sky (port 5173)

**Flow:** Compose timelock message → drand or SpaceComputer cTRNG → optional NameStone capsule.

### Run Sealed Sky

```bash
cd sealed-sky-web
npm install
cp .env.example .env.local   # add VITE_NAMESTONE_* if you use ENS publish
npm run dev
# → http://localhost:5173
```

Full product notes: **[`sealed-sky-web/README.md`](sealed-sky-web/README.md)**.

---

## USB Armory & Rust applet (GoTEE base)

The repo is still a **GoTEE Rust starter**: your trusted code lives in **`src/main.rs`** and runs on the USB Armory MK II in TrustZone. The Trusted OS exposes the JSON bridge on **`10.0.0.1:4000`**.

### Prerequisites

- USB Armory MK II + microSD + USB-C **data** cable
- [Docker](https://www.docker.com/)
- [Rust](https://rustup.rs/) (nightly per `rust-toolchain.toml`)
- ARM bare-metal binutils (`arm-none-eabi-ld`) — see [Embedded Rust / distro packages](https://docs.rust-embedded.org/)
- `nc` (netcat)
- [Bun](https://bun.sh/) — upload + tests

### Quick start (device)

```bash
./docker/build.sh
./scripts/flash-sd.sh /dev/diskN    # macOS / Linux — see script usage
# Boot from µSD, plug USB, then:
./scripts/armory-link.sh
printf '{"Method":"Echo","Input":"hi"}\n' | nc 10.0.0.1 4000
```

### Hot-swap applet

```bash
$EDITOR src/main.rs
make applet
bun run upload target/armv7a-none-eabi/release/trusted_applet
./scripts/armory-link.sh
```

### Bridge protocol (host → Armory)

TCP `10.0.0.1:4000`, newline-delimited JSON:

```text
→ {"Method":"Echo","Input":"hi"}
← {"Output":"hi"}
```

Methods other than `__upload` are forwarded to your `handle()` in `src/main.rs`.

### Architecture (high level)

```
┌─────────────────────────────────────────────┐
│           USB Armory MK II                  │
│  Secure World: Trusted OS + Rust applet     │
│  Bridge: 10.0.0.1:4000                      │
└─────────────────────────────────────────────┘
```

Trusted OS code: `docker/trusted_os/`. Syscalls: `docker/gotee_syscall/`. Deep dive: **[`CLAUDE.md`](CLAUDE.md)** (maintainers’ context).

---

## Project structure (monorepo)

```
trusted_edge_ai_oracle/
├── src/main.rs                 ← trusted applet (edit)
├── backend/                    ← Part 1: Express API + history + ENS publish
├── frontend/                   ← Part 1: static HTML (served at /ui/)
├── sealed-sky-web/             ← Part 2: Vite React app
├── trusted-edge-oracle/        ← Foundry Solidity oracle
├── docker/                     ← Trusted OS + image build
├── scripts/                    ← flash, armory-link, upload
├── examples/                   ← applet examples
├── Makefile
└── package.json                ← bun run upload
```

---

## Examples (applet)

Copy an example to `src/main.rs`, `make applet`, upload. See table in **[`CLAUDE.md`](CLAUDE.md)** or browse `examples/`.

---

## Testing (device)

```bash
sudo -v
./scripts/armory-link.sh
bun test
```

---

## Syscalls & RPC (applet ↔ Trusted OS)

| Syscall / RPC | Role |
|---------------|------|
| `serve(handler)` | Applet main loop |
| `RPC.Echo`, `RPC.LED`, `RPC.Attest` | OS services callable from Rust |

Full ABI: **`CLAUDE.md`** and `docker/gotee_syscall/`.

---

## Resources

- [GoTEE](https://github.com/usbarmory/GoTEE)
- [TamaGo](https://github.com/usbarmory/tamago)
- [USB Armory Wiki](https://github.com/usbarmory/usbarmory/wiki)
- [ENS text records](https://docs.ens.domains/web/records)

## License

Based on [GoTEE-example](https://github.com/usbarmory/GoTEE-example). See `LICENSE`.
