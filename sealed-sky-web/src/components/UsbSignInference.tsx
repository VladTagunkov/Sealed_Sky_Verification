import { useCallback, useEffect, useState } from "react";
import { sha256Utf8Hex0x, todayIsoDateLocal } from "../lib/sha256Hex";

const DEFAULT_SIGN_URL = "http://localhost:3000/sign-inference";

function signInferenceUrl(): string {
  const u = import.meta.env.VITE_SIGN_INFERENCE_URL?.trim();
  return u || DEFAULT_SIGN_URL;
}

interface Props {
  /** Queue item id — resets form when selection changes */
  itemId: string;
  /** Unlocked plaintext from the timelock */
  plaintext: string;
}

export function UsbSignInference({ itemId, plaintext }: Props) {
  const [sealedSkyText, setSealedSkyText] = useState(plaintext);
  const [timestamp, setTimestamp] = useState(todayIsoDateLocal);
  const [contentHash, setContentHash] = useState("");
  const [hashBusy, setHashBusy] = useState(false);
  const [hmacOut, setHmacOut] = useState("");
  const [rawResponse, setRawResponse] = useState("");
  const [signStatus, setSignStatus] = useState<"idle" | "busy" | "ok" | "err">("idle");
  const [signError, setSignError] = useState<string | null>(null);

  useEffect(() => {
    setSealedSkyText(plaintext);
    setTimestamp(todayIsoDateLocal());
    setHmacOut("");
    setRawResponse("");
    setSignStatus("idle");
    setSignError(null);
  }, [itemId, plaintext]);

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
        Timestamp (default: today&apos;s date)
        <input
          type="text"
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
          <summary>Raw JSON</summary>
          <pre className="usb-sign-raw">{rawResponse}</pre>
        </details>
      )}

      <p className="usb-sign-foot">
        <a href="http://localhost:3000/ui/input.html" target="_blank" rel="noreferrer">
          Open legacy Seal Sky Input page
        </a>
        {" · "}
        <a href="http://localhost:3000/ui/index.html" target="_blank" rel="noreferrer">
          Submit / verify
        </a>
      </p>
    </div>
  );
}
