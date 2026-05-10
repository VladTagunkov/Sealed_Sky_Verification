import { useCallback, useEffect, useState } from "react";
import { sha256Utf8Hex0x, unixSecondsNowString } from "../lib/sha256Hex";

const DEFAULT_SIGN_URL = "http://localhost:3000/sign-inference";
const DEFAULT_SUBMIT_URL = "http://localhost:3000/submit";

function signInferenceUrl(): string {
  const u = import.meta.env.VITE_SIGN_INFERENCE_URL?.trim();
  return u || DEFAULT_SIGN_URL;
}

function submitUrl(): string {
  const u = import.meta.env.VITE_SUBMIT_URL?.trim();
  return u || DEFAULT_SUBMIT_URL;
}

/** Backend compares proof to Node HMAC hex without 0x prefix. */
function normalizeProofHex(p: string): string {
  const t = p.trim();
  return t.startsWith("0x") || t.startsWith("0X") ? t.slice(2) : t;
}

interface Props {
  /** Queue item id — resets form when selection changes */
  itemId: string;
  /** Unlocked plaintext from the timelock */
  plaintext: string;
}

export function UsbSignInference({ itemId, plaintext }: Props) {
  const [sealedSkyText, setSealedSkyText] = useState(plaintext);
  const [timestamp, setTimestamp] = useState(unixSecondsNowString);
  const [contentHash, setContentHash] = useState("");
  const [hashBusy, setHashBusy] = useState(false);
  const [hmacOut, setHmacOut] = useState("");
  const [rawResponse, setRawResponse] = useState("");
  const [signStatus, setSignStatus] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [signError, setSignError] = useState<string | null>(null);

  const [proof, setProof] = useState("");
  const [submitStatus, setSubmitStatus] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [provedLabel, setProvedLabel] = useState("");
  const [txHash, setTxHash] = useState("");
  const [submitRaw, setSubmitRaw] = useState("");
  const [lockTime, setLockTime] = useState("");

  useEffect(() => {
    setSealedSkyText(plaintext);
    setTimestamp(unixSecondsNowString());
    setHmacOut("");
    setRawResponse("");
    setSignStatus("idle");
    setSignError(null);
    setProof("");
    setSubmitStatus("idle");
    setSubmitError(null);
    setProvedLabel("");
    setTxHash("");
    setSubmitRaw("");
    setLockTime("");
  }, [itemId, plaintext]);

  useEffect(() => {
    if (signStatus === "ok" && hmacOut) setProof(normalizeProofHex(hmacOut));
  }, [signStatus, hmacOut]);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      setHashBusy(true);
      try {
        const h = await sha256Utf8Hex0x(sealedSkyText);
        if (!cancelled) setContentHash(h);
      } catch {
        if (!cancelled) setContentHash("");
      } finally {
        if (!cancelled) setHashBusy(false);
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [sealedSkyText]);

  const onSign = useCallback(async () => {
    setSignStatus("busy");
    setSignError(null);
    setHmacOut("");
    setRawResponse("");
    const url = signInferenceUrl();
    const body = {
      sealedSkyText: sealedSkyText.trim(),
      timestamp: timestamp.trim(),
      imageHash: contentHash.trim(),
    };
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { raw: text };
      }
      setRawResponse(JSON.stringify(parsed, null, 2));
      if (!res.ok) {
        setSignStatus("err");
        setSignError(
          typeof parsed.error === "string"
            ? parsed.error
            : `HTTP ${res.status}`,
        );
        return;
      }
      const hash = typeof parsed.hash === "string" ? parsed.hash : "";
      setHmacOut(hash);
      setSignStatus("ok");
    } catch (e) {
      setSignStatus("err");
      setSignError(e instanceof Error ? e.message : String(e));
      setRawResponse("");
    }
  }, [sealedSkyText, timestamp, contentHash]);

  const onSubmitSepolia = useCallback(async () => {
    setSubmitStatus("busy");
    setSubmitError(null);
    setProvedLabel("");
    setTxHash("");
    setSubmitRaw("");
    setLockTime(new Date().toLocaleString());

    const tsNum = Number(timestamp.trim());
    if (!Number.isFinite(tsNum)) {
      setSubmitStatus("err");
      setSubmitError("Timestamp must be a valid number (Unix seconds), matching the SignInference payload.");
      return;
    }

    const normProof = normalizeProofHex(proof);
    if (!normProof) {
      setSubmitStatus("err");
      setSubmitError("Paste the device HMAC proof (run SignInference first, or enter hex manually).");
      return;
    }

    const body = {
      sealedSkyText: sealedSkyText.trim(),
      timestamp: tsNum,
      imageHash: contentHash.trim(),
      proof: normProof,
    };

    try {
      const res = await fetch(submitUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const text = await res.text();
      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(text) as Record<string, unknown>;
      } catch {
        parsed = { raw: text };
      }
      setSubmitRaw(JSON.stringify(parsed, null, 2));

      const success = parsed.success === true;
      const fail = parsed.success === false;
      const tx = typeof parsed.tx === "string" ? parsed.tx : "";

      if (!res.ok) {
        setSubmitStatus("err");
        setSubmitError(typeof parsed.error === "string" ? parsed.error : `HTTP ${res.status}`);
        setProvedLabel("");
        setTxHash("");
        return;
      }

      if (success) {
        setSubmitStatus("ok");
        setProvedLabel("Success — verified & submitted on-chain");
        setTxHash(tx);
      } else if (fail) {
        setSubmitStatus("err");
        setSubmitError(typeof parsed.error === "string" ? parsed.error : "verification failed");
        setProvedLabel("Failed — proof did not match (check fields match SignInference)");
        setTxHash("");
      } else {
        setSubmitStatus("ok");
        setProvedLabel("Done");
        setTxHash(tx);
      }
    } catch (e) {
      setSubmitStatus("err");
      setSubmitError(e instanceof Error ? e.message : String(e));
    }
  }, [sealedSkyText, timestamp, contentHash, proof]);

  return (
    <div className="usb-sign-panel">
      <div className="envelope-header">
        <span>USB verification (SignInference)</span>
      </div>
      <p className="usb-sign-lead">
        Build the same pipe-delimited payload as Seal Sky Input:{" "}
        <code className="mono">text|timestamp|content_hash</code>, then HMAC on the USB Armory via
        the Node backend (<code className="mono">nc 10.0.0.1 4000</code>).
      </p>

      <label className="usb-sign-label">
        Sealed sky text
        <textarea
          value={sealedSkyText}
          onChange={(e) => setSealedSkyText(e.target.value)}
          rows={4}
          className="usb-sign-textarea"
        />
      </label>

      <label className="usb-sign-label">
        Timestamp — Unix seconds (same for USB HMAC and Sepolia{" "}
        <code className="mono">uint256</code>; default when unlocked: now)
        <input
          type="text"
          inputMode="numeric"
          value={timestamp}
          onChange={(e) => setTimestamp(e.target.value)}
          className="usb-sign-input"
          autoComplete="off"
        />
      </label>

      <label className="usb-sign-label">
        SHA-256 of sealed sky text (UTF-8) — sent as{" "}
        <code className="mono">imageHash</code>
        <input
          type="text"
          readOnly
          value={hashBusy ? "computing…" : contentHash}
          className="usb-sign-input mono"
        />
      </label>

      <div className="usb-sign-endpoint">
        <span className="muted">POST </span>
        <code className="mono">{signInferenceUrl()}</code>
        <span className="muted">
          {" "}
          — override with <code className="mono">VITE_SIGN_INFERENCE_URL</code>
        </span>
      </div>

      <div className="usb-sign-actions">
        <button type="button" className="usb-sign-btn" onClick={() => void onSign()} disabled={signStatus === "busy" || !contentHash}>
          {signStatus === "busy" ? "Signing…" : "Send to USB (SignInference)"}
        </button>
        {signStatus === "ok" && <span className="usb-sign-ok">Device HMAC received</span>}
        {signStatus === "err" && signError && (
          <span className="usb-sign-err">{signError}</span>
        )}
      </div>

      {hmacOut && (
        <label className="usb-sign-label">
          HMAC-SHA256 (hex, from Armory)
          <input type="text" readOnly value={hmacOut} className="usb-sign-input mono" />
        </label>
      )}

      {rawResponse && (
        <details className="usb-sign-details">
          <summary>Raw JSON (SignInference)</summary>
          <pre className="usb-sign-raw">{rawResponse}</pre>
        </details>
      )}

      <div className="sepolia-submit-panel">
        <div className="envelope-header">
          <span>Sepolia on-chain validation</span>
        </div>
        <p className="sepolia-submit-lead">
          Same payload as the{" "}
          <a href="http://localhost:3000/ui/index.html" target="_blank" rel="noreferrer">
            verification index
          </a>
          : backend re-verifies the HMAC proof, then the relayer calls{" "}
          <code className="mono">TrustedEdgeOracle.submitInference</code> on Sepolia.
        </p>

        <label className="usb-sign-label">
          Proof (HMAC-SHA256 hex from Armory — auto-filled after SignInference)
          <textarea
            value={proof}
            onChange={(e) => setProof(e.target.value)}
            rows={3}
            className="usb-sign-textarea"
            placeholder="64-char hex (optional 0x prefix stripped on send)"
            spellCheck={false}
          />
        </label>

        <div className="usb-sign-endpoint">
          <span className="muted">POST </span>
          <code className="mono">{submitUrl()}</code>
          <span className="muted">
            {" "}
            — override with <code className="mono">VITE_SUBMIT_URL</code>
          </span>
        </div>

        <div className="usb-sign-actions">
          <button
            type="button"
            className="sepolia-submit-btn"
            onClick={() => void onSubmitSepolia()}
            disabled={submitStatus === "busy" || !contentHash}
          >
            {submitStatus === "busy" ? "Submitting…" : "Verify & submit on Sepolia"}
          </button>
          {submitStatus === "ok" && provedLabel && (
            <span className="sepolia-submit-ok">{provedLabel}</span>
          )}
          {submitStatus === "err" && submitError && (
            <span className="usb-sign-err">{submitError}</span>
          )}
        </div>

        {(txHash || lockTime) && (
          <dl className="sepolia-submit-dl">
            {lockTime && (
              <>
                <dt>Submitted at</dt>
                <dd>{lockTime}</dd>
              </>
            )}
            {txHash && (
              <>
                <dt>Sepolia tx</dt>
                <dd>
                  <a
                    href={`https://sepolia.etherscan.io/tx/${txHash}`}
                    target="_blank"
                    rel="noreferrer"
                    className="sepolia-tx-link"
                  >
                    {txHash}
                  </a>
                </dd>
              </>
            )}
          </dl>
        )}

        {submitRaw && (
          <details className="usb-sign-details">
            <summary>Raw JSON (/submit)</summary>
            <pre className="usb-sign-raw">{submitRaw}</pre>
          </details>
        )}
      </div>

      <p className="usb-sign-foot">
        <a href="http://localhost:3000/ui/input.html" target="_blank" rel="noreferrer">
          Legacy Seal Sky Input
        </a>
        {" · "}
        <a href="http://localhost:3000/ui/index.html" target="_blank" rel="noreferrer">
          Full-screen submit UI
        </a>
      </p>
    </div>
  );
}
