const express = require("express");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const SEALED_SKY_DIR = path.join(__dirname, "..", "sealed-sky-web");
// Support both `_env.local` (some setups) and standard `.env.local`.
require("dotenv").config({ path: path.join(SEALED_SKY_DIR, "_env.local") });
require("dotenv").config({ path: path.join(SEALED_SKY_DIR, ".env.local") });
require("dotenv").config({ path: path.join(__dirname, ".env") });

const app = express();
const FRONTEND_DIR = path.join(__dirname, "..", "frontend");

app.use(express.json());
app.use("/ui", express.static(FRONTEND_DIR));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

const wallet = new ethers.Wallet(
  process.env.PRIVATE_KEY,
  provider
);

const contractAddress = "0xe41533f4de18D5aBa3905192a9933087B067aa4b";

const abi = [
  "function submitInference(string,string,uint256,string,bytes32)"
];

const contract = new ethers.Contract(
  contractAddress,
  abi,
  wallet
);

const DEVICE_SECRET =
  "hackathon-demo-key-32bytes!!!!";
const DEFAULT_SEALED_SKY_TEXT = "seal_sky_seal_box_text";
const NAMESTONE_API = "https://namestone.com/api/public_v1";
const LEGACY_CONTEXT_PREFIX = "pothole_detected";

/** Text record keys we publish for validation history (ENS custom records). */
const VALIDATION_ENS_TEXT_KEYS = [
  "com.sealedsky.validation_history",
  "com.sealedsky.validation_total",
  "com.sealedsky.validation_slice",
  "com.sealedsky.validation_updated_at",
  "com.sealedsky.validation_app",
  "com.sealedsky.validation_scope",
  "description",
];

function sealedSkyTextFromBody(body) {
  const raw =
    typeof body.sealedSkyText === "string"
      ? body.sealedSkyText
      : typeof body.result === "string"
        ? body.result
        : "";
  const trimmed = raw.trim();
  return trimmed || DEFAULT_SEALED_SKY_TEXT;
}
const HISTORY_FILE_PATH = path.join(__dirname, "json_history_validation.json");

function readHistory() {
  try {
    const content = fs.readFileSync(HISTORY_FILE_PATH, "utf8");
    const parsed = JSON.parse(content);
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    // Missing file on first run is expected.
    if (error && error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function appendHistory(record) {
  const history = readHistory();
  history.push(record);
  fs.writeFileSync(HISTORY_FILE_PATH, JSON.stringify(history, null, 2), "utf8");
}

function namestoneConfig() {
  const apiKey =
    process.env.NAMESTONE_API_KEY ||
    process.env.VITE_NAMESTONE_API_KEY ||
    "";
  const parentDomain =
    process.env.NAMESTONE_DOMAIN ||
    process.env.VITE_NAMESTONE_DOMAIN ||
    "";
  return { apiKey, parentDomain };
}

function sanitizeEnsLabel(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
  return (s || "oracle-validation").slice(0, 63);
}

/** e.g. oracle-validation.id144.eth -> { label, parent } */
function splitEnsSubdomainAndParent(ensName) {
  const n = ensName.trim().toLowerCase();
  const parts = n.split(".");
  if (parts.length < 3) return null;
  const parent = parts.slice(-2).join(".");
  const label = parts.slice(0, -2).join(".");
  if (!label || !parent) return null;
  return { label, parent, full: `${label}.${parent}` };
}

/**
 * Read text records via NameStone HTTP API (reliable from Node).
 * On-chain getText often fails here (CCIP-read + public RPC).
 */
async function readValidationTextRecordsViaNameStone(ensName) {
  const parsed = splitEnsSubdomainAndParent(ensName);
  if (!parsed) {
    return { ok: false, reason: "not_a_subdomain", detail: ensName };
  }
  const { apiKey } = namestoneConfig();
  const url = new URL(`${NAMESTONE_API}/get-names`);
  url.searchParams.set("domain", parsed.parent);
  url.searchParams.set("text_records", "1");
  url.searchParams.set("limit", "500");
  const headers = {};
  if (apiKey) headers.Authorization = apiKey;
  const r = await fetch(url, { headers });
  if (!r.ok) {
    const text = await r.text().catch(() => "");
    return {
      ok: false,
      reason: "namestone_http",
      status: r.status,
      detail: text || r.statusText,
    };
  }
  const list = await r.json();
  if (!Array.isArray(list)) {
    return { ok: false, reason: "namestone_bad_json" };
  }
  const want = parsed.full;
  const row = list.find((item) => {
    if (!item || typeof item.name !== "string" || typeof item.domain !== "string") {
      return false;
    }
    return `${item.name}.${item.domain}`.toLowerCase() === want;
  });
  if (!row) {
    return {
      ok: false,
      reason: "namestone_not_found",
      detail: `no row for ${want} in first ${list.length} names`,
    };
  }
  const tr = row.text_records && typeof row.text_records === "object"
    ? row.text_records
    : {};
  const records = {};
  for (const key of VALIDATION_ENS_TEXT_KEYS) {
    records[key] = tr[key] ?? null;
  }
  return { ok: true, records, matched: want };
}

/**
 * Publish validation history as ENS text records via NameStone (same API as sealed-sky-web).
 * Keys are namespaced (see https://docs.ens.domains/web/records — custom records).
 */
async function publishValidationHistoryToEns(options = {}) {
  const { apiKey, parentDomain } = namestoneConfig();
  if (!apiKey || !parentDomain) {
    throw new Error(
      "NameStone not configured: set VITE_NAMESTONE_API_KEY and VITE_NAMESTONE_DOMAIN in sealed-sky-web/_env.local or .env.local (or NAMESTONE_* in backend/.env)",
    );
  }

  const history = readHistory();
  const scope = options.scope === "last" ? "last" : "full";
  const maxLen = 45000;
  let slice;
  let description;

  if (scope === "last") {
    if (!history.length) {
      throw new Error("no validation history to publish");
    }
    slice = [history[history.length - 1]];
    const last = slice[0];
    const st = last.status || "unknown";
    description = `Trusted Edge Oracle — last validation (${st}, ${last.receivedAt || ""})`;
  } else {
    const maxEntries = Math.min(
      Math.max(Number(options.maxEntries) || 200, 1),
      500,
    );
    slice = history.slice(-maxEntries);
    let jsonPayload = JSON.stringify(slice);
    while (jsonPayload.length > maxLen && slice.length > 1) {
      slice = slice.slice(1);
      jsonPayload = JSON.stringify(slice);
    }
    if (jsonPayload.length > maxLen) {
      throw new Error(
        "Validation history JSON is too large for one ENS text record; reduce maxEntries or shorten stored fields",
      );
    }
    description = `Trusted Edge Oracle validation history (${history.length} events, last ${slice.length} published)`;
  }

  const jsonPayload = JSON.stringify(slice);
  if (jsonPayload.length > maxLen) {
    throw new Error("last validation record JSON is too large for one ENS text record");
  }

  const defaultSub =
    scope === "last" ? "oracle-validation-last" : "oracle-validation";
  const label = sanitizeEnsLabel(
    options.subdomain != null && String(options.subdomain).trim()
      ? options.subdomain
      : defaultSub,
  );
  const owner = wallet.address;

  const body = {
    domain: parentDomain,
    name: label,
    address: owner,
    text_records: {
      "com.sealedsky.validation_history": jsonPayload,
      "com.sealedsky.validation_total": String(history.length),
      "com.sealedsky.validation_slice": String(slice.length),
      "com.sealedsky.validation_updated_at": new Date().toISOString(),
      "com.sealedsky.validation_app": "trusted-edge-oracle",
      "com.sealedsky.validation_scope": scope,
      description,
    },
  };

  const r = await fetch(`${NAMESTONE_API}/set-name`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: apiKey,
    },
    body: JSON.stringify(body),
  });

  if (!r.ok) {
    const text = await r.text().catch(() => "");
    throw new Error(`NameStone set-name HTTP ${r.status}: ${text || r.statusText}`);
  }

  const fqn = `${label}.${parentDomain}`;
  const truncated = scope === "full" && slice.length < history.length;
  return {
    ens: fqn,
    scope,
    truncated,
    total: history.length,
    published: slice.length,
  };
}

app.get("/history", (req, res) => {
  const history = readHistory();
  const limitRaw = Number(req.query.limit);
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.floor(limitRaw) : 3;
  const lastItems = history.slice(-limit).reverse();
  res.json({
    total: history.length,
    count: lastItems.length,
    items: lastItems
  });
});

app.post("/submit", async (req, res) => {
  const {
    timestamp,
    imageHash,
    proof
  } = req.body;

  const receivedAt = new Date().toISOString();
  const sealedSkyText = sealedSkyTextFromBody(req.body);

  const isTimestampValid =
    Number.isFinite(Number(timestamp)) || typeof timestamp === "string";
  const isImageHashValid = typeof imageHash === "string" && imageHash.trim().length > 0;
  const isProofValid = typeof proof === "string" && proof.trim().length > 0;

  if (!isTimestampValid || !isImageHashValid || !isProofValid) {
    appendHistory({
      receivedAt,
      status: "rejected",
      reason: "invalid input",
      sealedSkyText,
      timestamp,
      imageHash,
      proof
    });
    return res.status(400).json({
      error: "timestamp, imageHash and proof are required"
    });
  }

  const canonicalPayload = `${sealedSkyText}|${timestamp}|${imageHash}`;
  // Compatibility mode:
  // - canonical format: text|timestamp|imageHash
  // - legacy applet format: pothole_detected|text|timestamp|imageHash
  const legacyPayload = `${LEGACY_CONTEXT_PREFIX}|${canonicalPayload}`;
  const expectedCanonical = crypto
    .createHmac("sha256", DEVICE_SECRET)
    .update(canonicalPayload)
    .digest("hex");
  const expectedLegacy = crypto
    .createHmac("sha256", DEVICE_SECRET)
    .update(legacyPayload)
    .digest("hex");
  const matchedPayload =
    proof === expectedCanonical
      ? canonicalPayload
      : proof === expectedLegacy
        ? legacyPayload
        : null;

  if (!matchedPayload) {
    appendHistory({
      receivedAt,
      status: "rejected",
      reason: "invalid proof",
      sealedSkyText,
      timestamp,
      imageHash,
      proof,
      canonicalPayload,
      legacyPayload
    });
    return res.json({
      success: false,
      verified: false,
      error: "invalid proof",
      receivedAt
    });
  }

  // Create payload hash
  const payloadHash = ethers.keccak256(
    ethers.toUtf8Bytes(matchedPayload)
  );

  // Submit onchain
  const tx = await contract.submitInference(
    "armory-mk2-alpha",
    sealedSkyText,
    timestamp,
    imageHash,
    payloadHash
  );

  await tx.wait();

  const historyRecord = {
    receivedAt,
    status: "accepted",
    sealedSkyText,
    timestamp,
    imageHash,
    proof,
    payload: matchedPayload,
    payloadHash,
    tx: tx.hash
  };
  appendHistory(historyRecord);

  res.json({
    success: true,
    tx: tx.hash,
    receivedAt
  });
});

app.post("/sign-inference", (req, res) => {
  const {
    timestamp,
    imageHash
  } = req.body;

  if (
    typeof imageHash !== "string" ||
    (!Number.isFinite(Number(timestamp)) && typeof timestamp !== "string")
  ) {
    return res.status(400).json({
      error: "timestamp and imageHash are required"
    });
  }

  const sealedSkyText = sealedSkyTextFromBody(req.body);
  const payload = `${sealedSkyText}|${timestamp}|${imageHash}`;
  const requestLine = `${JSON.stringify({
    Method: "SignInference",
    Input: payload
  })}\n`;

  const ncResult = spawnSync(
    "nc",
    ["-w", "5", "10.0.0.1", "4000"],
    {
      input: requestLine,
      encoding: "utf8"
    }
  );

  if (ncResult.status !== 0) {
    return res.status(502).json({
      error: "failed to reach USB device",
      details: ncResult.stderr || "nc exited with non-zero status"
    });
  }

  const rawOutput = (ncResult.stdout || "").trim();

  if (!rawOutput) {
    return res.status(502).json({
      error: "device returned empty response"
    });
  }

  let parsed;
  try {
    parsed = JSON.parse(rawOutput);
  } catch {
    return res.status(502).json({
      error: "invalid response from device",
      raw: rawOutput
    });
  }

  if (parsed.Error) {
    return res.status(502).json({
      error: parsed.Error
    });
  }

  return res.json({
    hash: parsed.Output || ""
  });
});

app.post("/publish-validation-ens", async (req, res) => {
  try {
    const out = await publishValidationHistoryToEns(req.body || {});
    res.json({
      success: true,
      ens: out.ens,
      scope: out.scope,
      ensAppUrl: `https://app.ens.domains/${out.ens}`,
      readApiUrl: `http://localhost:3000/read-validation-ens?ens=${encodeURIComponent(out.ens)}`,
      total: out.total,
      published: out.published,
      truncated: out.truncated,
    });
  } catch (e) {
    res.status(400).json({
      success: false,
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

/**
 * Read validation text records.
 * Prefer NameStone get-names (works from Node); fallback to on-chain resolver + getText.
 */
app.get("/read-validation-ens", async (req, res) => {
  const ensName = (req.query.ens || "").trim();
  if (!ensName) {
    return res.status(400).json({
      error: "missing ?ens= (example: oracle-validation.id144.eth)",
    });
  }

  const rpcCandidates = [
    process.env.ENS_MAINNET_RPC_URL,
    "https://eth.llamarpc.com",
    "https://ethereum.publicnode.com",
    "https://cloudflare-eth.com",
  ].filter((u) => typeof u === "string" && u.trim().length > 0);

  function buildPayload(source, records, extra = {}) {
    let history = null;
    const rawHistory = records["com.sealedsky.validation_history"];
    if (rawHistory) {
      try {
        history = JSON.parse(rawHistory);
      } catch {
        history = null;
      }
    }
    return {
      ens: ensName,
      source,
      ensAppUrl: `https://app.ens.domains/${ensName}`,
      records,
      history,
      ...extra,
    };
  }

  try {
    const ns = await readValidationTextRecordsViaNameStone(ensName);
    if (ns.ok) {
      return res.json(
        buildPayload("namestone", ns.records, {
          matched: ns.matched,
          hint: "Include Authorization (API key) on get-names if your subnames are private.",
        }),
      );
    }

    let lastErr = `${ns.reason}: ${ns.detail || ""}`;
    for (const rpc of rpcCandidates) {
      try {
        const ensProvider = new ethers.JsonRpcProvider(rpc.trim());
        const resolver = await ensProvider.getResolver(ensName);
        if (!resolver) {
          lastErr = "no resolver";
          continue;
        }
        const records = {};
        for (const key of VALIDATION_ENS_TEXT_KEYS) {
          try {
            records[key] = await resolver.getText(key);
          } catch {
            records[key] = null;
          }
        }
        return res.json(
          buildPayload("ens", records, {
            mainnetRpc: rpc.trim(),
            namestoneFallback: ns.reason,
          }),
        );
      } catch (e) {
        lastErr = e instanceof Error ? e.message : String(e);
      }
    }

    return res.status(502).json({
      error: lastErr,
      hint:
        "NameStone reads: use the same API key as publish (private subnames need Authorization). " +
        "ENS fallback: set ENS_MAINNET_RPC_URL to a full archive/mainnet provider if CCIP calls fail.",
      namestone: ns,
    });
  } catch (e) {
    res.status(500).json({
      error: e instanceof Error ? e.message : String(e),
    });
  }
});

app.listen(3000, () => {
  console.log("server running");
});