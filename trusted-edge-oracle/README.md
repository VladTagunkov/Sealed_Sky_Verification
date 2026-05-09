# Trusted Edge Oracle — Solidity (Foundry)

This package is the **on-chain** part of the hackathon stack: a small oracle contract that records attestations when your **backend relayer** submits verified inference payloads (after the USB Armory proof checks out).

The **USB Armory applet**, **Node backend**, and **static frontend** live in the **parent repository** (`../`). This folder only builds and deploys the contract.

## What the contract does

- **`submitInference(deviceId, result, timestamp, imageHash, payloadHash)`** — callable only by **authorized relayers**.
- On deploy, the **deployer** is `owner` and is **automatically** an authorized relayer.
- Each submission is stored and emits **`InferenceAttested`**.

Source: [`src/TrustedEdgeOracle.sol`](src/TrustedEdgeOracle.sol).

## Prerequisites

- [Foundry](https://book.getfoundry.sh/getting-started/installation) (`forge`, `cast`, …)
- A wallet with **Sepolia ETH** (or your target network’s native token) for gas
- An **RPC URL** for that network (Infura, Alchemy, public RPC, etc.)

## Install & build

From **this directory**:

```bash
cd trusted-edge-oracle
forge install   # if submodules are missing
forge build
```

Run tests (if you add them):

```bash
forge test
```

## Deploy

### 1. Environment

Use a **`.env`** file in this directory (Foundry loads it for `forge script`), or export variables in your shell:

```bash
# .env (do not commit real keys)
PRIVATE_KEY=0x...          # deployer — will be owner + first relayer
SEPOLIA_RPC_URL=https://... # your Sepolia HTTPS endpoint
```

### 2. Broadcast deploy

Example for **Sepolia** (chain id `11155111`):

```bash
source .env
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast
```

After it succeeds, note the **deployed contract address** from the terminal output or from:

```text
broadcast/Deploy.s.sol/11155111/run-latest.json
```

### 3. (Optional) Verify on a block explorer

If your Foundry profile has `etherscan_api_key` / chain config set:

```bash
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --private-key "$PRIVATE_KEY" \
  --broadcast \
  --verify
```

## Connect the parent repo backend

The Express backend submits txs to this contract. After each deploy you must point it at the **new address**.

1. Open **`../backend/server.js`** and set `contractAddress` to your deployed `TrustedEdgeOracle` address.

2. Configure **`../backend/.env`** (or your process environment) so the **same** wallet that deployed the contract is used to send transactions:
   - **`PRIVATE_KEY`** — must match the deployer (only that account is a relayer by default).
   - **`RPC_URL`** — must be the **same network** you deployed to (e.g. Sepolia).

3. Restart the backend:

   ```bash
   cd ../backend
   node server.js
   ```

Successful **`POST /submit`** flows will then call `submitInference` on-chain.

### Extra relayers

Only addresses in **`authorizedRelayers`** may call `submitInference`. To add another signer (e.g. ops wallet), the **owner** must call **`authorizeRelayer(address)`** on the deployed contract (`cast send` or a small script).

## Full stack (Armory + UI + ENS)

- **Trusted applet & bridge:** see [`../README.md`](../README.md) and [`../CLAUDE.md`](../CLAUDE.md).
- **Seal Sky Verification UI:** `../frontend/` (served under `http://localhost:3000/ui/` when the backend runs).
- **Optional ENS publish (NameStone):** configure `VITE_NAMESTONE_*` or `NAMESTONE_*` as documented in the parent project; history page can publish full or last-only snapshots.

## Security notes (hackathon demo)

- Treat **`PRIVATE_KEY`** as secret; never commit it.
- The bridge on the Armory has **no authentication**; this repo is for demos, not production.
- Align **chain ID**, **contract address**, and **relayer key** — mismatches produce revert or wrong network errors.

## Foundry reference

| Task        | Command        |
|------------|----------------|
| Build      | `forge build`  |
| Test       | `forge test`   |
| Format     | `forge fmt`    |
| Local node | `anvil`        |

Full docs: [Foundry Book](https://book.getfoundry.sh/).
