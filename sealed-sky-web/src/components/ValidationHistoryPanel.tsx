import { useCallback, useEffect, useMemo, useState } from "react";

type HistoryStatus = "accepted" | "rejected" | string;

interface ValidationItem {
  receivedAt?: string;
  status?: HistoryStatus;
  stage?: string;
  note?: string;
  sealedSkyText?: string;
  result?: string;
  timestamp?: string | number;
  imageHash?: string;
  proof?: string;
  reason?: string;
  error?: string;
  details?: string;
  raw?: string;
  tx?: string;
}

interface HistoryResponse {
  items?: ValidationItem[];
}

interface PublishResponse {
  scope?: string;
  ens?: string;
  ensAppUrl?: string;
  readApiUrl?: string;
  published?: number;
  truncated?: boolean;
  error?: string;
}

const HISTORY_ENDPOINT = "http://localhost:3000/history?limit=3";
const HISTORY_LATEST_ENDPOINT = "http://localhost:3000/history?limit=1";
const PUBLISH_ENS_ENDPOINT = "http://localhost:3000/publish-validation-ens";

function fmt(value: unknown): string {
  if (value === undefined || value === null) return "";
  return String(value);
}

export function ValidationHistoryPanel() {
  const [items, setItems] = useState<ValidationItem[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [statusErr, setStatusErr] = useState(false);
  const [ensPublish, setEnsPublish] = useState<PublishResponse | null>(null);
  /** Latest history row after ENS publish (for status / proof / tx in the summary card). */
  const [ensPublishLatest, setEnsPublishLatest] = useState<ValidationItem | null>(null);
  const [ensPublishError, setEnsPublishError] = useState("");
  const [ensBusy, setEnsBusy] = useState(false);

  const setUiStatus = useCallback((message: string, isError = false) => {
    setStatus(message);
    setStatusErr(isError);
  }, []);

  const loadHistory = useCallback(async () => {
    setBusy(true);
    setUiStatus("Loading…");
    try {
      const res = await fetch(HISTORY_ENDPOINT);
      const data = (await res.json()) as HistoryResponse;
      if (!res.ok) {
        throw new Error(
          typeof (data as { error?: unknown }).error === "string"
            ? (data as { error: string }).error
            : `HTTP ${res.status}`,
        );
      }
      setItems(Array.isArray(data.items) ? data.items : []);
      setUiStatus("Done");
    } catch (e) {
      setItems([]);
      setUiStatus("Load error", true);
    } finally {
      setBusy(false);
    }
  }, [setUiStatus]);

  const publishToEns = useCallback(
    async (
      payload: Record<string, unknown>,
      label: string,
    ) => {
      setEnsPublish(null);
      setEnsPublishLatest(null);
      setEnsPublishError("");
      setEnsBusy(true);
      setUiStatus(label);
      try {
        const res = await fetch(PUBLISH_ENS_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        const data = (await res.json().catch(() => ({}))) as PublishResponse;
        if (!res.ok) {
          setEnsPublishError(data.error || `HTTP ${res.status}`);
          setUiStatus("ENS publish failed", true);
          return;
        }

        setEnsPublish(data);
        try {
          const hr = await fetch(HISTORY_LATEST_ENDPOINT);
          const hd = (await hr.json()) as HistoryResponse;
          if (hr.ok && Array.isArray(hd.items) && hd.items[0]) {
            setEnsPublishLatest(hd.items[0]);
          }
        } catch {
          /* ignore */
        }
        setUiStatus("Done");
      } catch (e) {
        setEnsPublishError(String(e));
        setUiStatus("ENS publish error", true);
      } finally {
        setEnsBusy(false);
      }
    },
    [setUiStatus],
  );

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    const onRefresh = () => void loadHistory();
    window.addEventListener("sealedsky-validation-history", onRefresh);
    return () => window.removeEventListener("sealedsky-validation-history", onRefresh);
  }, [loadHistory]);

  const hasItems = useMemo(() => items.length > 0, [items]);

  return (
    <section className="panel validation-history-panel">
      <h2>Validation History</h2>
      <p className="vh-subtitle">
        Last 3 validation results from backend history, with ENS publish actions.
      </p>

      <div className="vh-actions">
        <button type="button" className="vh-btn-primary" onClick={() => void loadHistory()} disabled={busy || ensBusy}>
          {busy ? "Loading…" : "Refresh"}
        </button>
        <button
          type="button"
          className="vh-btn-indigo"
          onClick={() =>
            void publishToEns(
              { scope: "full", maxEntries: 200, subdomain: "oracle-validation" },
              "Publishing full history to ENS…",
            )
          }
          disabled={ensBusy}
        >
          Publish full history to ENS
        </button>
        <button
          type="button"
          className="vh-btn-purple"
          onClick={() =>
            void publishToEns(
              { scope: "last", subdomain: "oracle-validation-last" },
              "Publishing last result to ENS…",
            )
          }
          disabled={ensBusy}
        >
          Publish last result to ENS
        </button>
        <span className={`vh-status${statusErr ? " is-error" : ""}`}>{status}</span>
      </div>

      {ensPublishError && <p className="vh-ens-result vh-ens-error">{ensPublishError}</p>}

      {ensPublish && (ensPublish.ens || ensPublish.ensAppUrl || ensPublish.readApiUrl) && (
        <div className="vh-ens-card">
          <div className="vh-ens-card-title">ENS publish</div>
          <div className="vh-ens-meta">
            {ensPublish.scope !== undefined && ensPublish.scope !== "" && (
              <div>
                <span className="vh-k">Scope:</span>{" "}
                <span className="vh-v">{ensPublish.scope}</span>
              </div>
            )}
            {ensPublish.ens && (
              <div>
                <span className="vh-k">ENS:</span> <span className="vh-v">{ensPublish.ens}</span>
              </div>
            )}
            {ensPublish.ensAppUrl && (
              <div>
                <span className="vh-k">App:</span>{" "}
                <span className="vh-v vh-ens-plain-url">{ensPublish.ensAppUrl}</span>
              </div>
            )}
            {ensPublish.readApiUrl && (
              <div>
                <span className="vh-k">JSON:</span>{" "}
                <span className="vh-v vh-ens-plain-url">{ensPublish.readApiUrl}</span>
              </div>
            )}
            {ensPublishLatest && (
              <>
                <div className="vh-ens-latest-sep" />
                <div>
                  <span className="vh-k">Status:</span>{" "}
                  <span
                    className={`vh-status-badge ${
                      ensPublishLatest.status === "accepted"
                        ? "accepted"
                        : ensPublishLatest.status === "device_signed"
                          ? "device-signed"
                          : "rejected"
                    }`}
                  >
                    {fmt(ensPublishLatest.status || "unknown")}
                  </span>
                </div>
                <div>
                  <span className="vh-k">Accepted:</span>{" "}
                  <span className="vh-v">
                    {ensPublishLatest.status === "accepted" ? "Yes" : "No"}
                  </span>
                </div>
                <div>
                  <span className="vh-k">proof:</span>{" "}
                  <span className="vh-v">{fmt(ensPublishLatest.proof) || "—"}</span>
                </div>
                <div>
                  <span className="vh-k">tx:</span>{" "}
                  <span className="vh-v">{fmt(ensPublishLatest.tx) || "—"}</span>
                </div>
              </>
            )}
            {typeof ensPublish.published === "number" && (
              <div>
                <span className="vh-k">Published rows:</span>{" "}
                <span className="vh-v">{ensPublish.published}</span>
              </div>
            )}
            {ensPublish.truncated && (
              <div>
                <span className="vh-k">Note:</span>{" "}
                <span className="vh-v">(subset in history blob — see com.sealedsky.validation_* records)</span>
              </div>
            )}
          </div>
          {ensPublish.readApiUrl && (
            <div className="vh-ens-json-link-wrap">
              <a
                href={ensPublish.readApiUrl}
                target="_blank"
                rel="noreferrer"
                className="vh-ens-link"
              >
                Open validation JSON
              </a>
            </div>
          )}
        </div>
      )}

      <div className="vh-list">
        {!hasItems && <div className="vh-item">No validation history yet.</div>}
        {items.map((item, idx) => {
          const statusClass =
            item.status === "accepted"
              ? "accepted"
              : item.status === "device_signed"
                ? "device-signed"
                : "rejected";
          return (
            <article className="vh-item" key={`${item.receivedAt || "entry"}-${idx}`}>
              <div>
                Status: <span className={`vh-status-badge ${statusClass}`}>{fmt(item.status || "unknown")}</span>
              </div>
              {item.stage && (
                <div><span className="vh-k">stage:</span> <span className="vh-v">{fmt(item.stage)}</span></div>
              )}
              {item.note && (
                <div><span className="vh-k">note:</span> <span className="vh-v">{fmt(item.note)}</span></div>
              )}
              <div><span className="vh-k">receivedAt:</span> <span className="vh-v">{fmt(item.receivedAt)}</span></div>
              <div><span className="vh-k">Sealed Sky Text:</span> <span className="vh-v">{fmt(item.sealedSkyText || item.result)}</span></div>
              <div><span className="vh-k">timestamp:</span> <span className="vh-v">{fmt(item.timestamp)}</span></div>
              <div><span className="vh-k">imageHash:</span> <span className="vh-v">{fmt(item.imageHash)}</span></div>
              <div><span className="vh-k">proof:</span> <span className="vh-v">{fmt(item.proof)}</span></div>
              {item.reason && <div><span className="vh-k">reason:</span> <span className="vh-v">{fmt(item.reason)}</span></div>}
              {item.error && <div><span className="vh-k">error:</span> <span className="vh-v">{fmt(item.error)}</span></div>}
              {item.details && <div><span className="vh-k">details:</span> <span className="vh-v">{fmt(item.details)}</span></div>}
              {item.raw && <div><span className="vh-k">raw:</span> <span className="vh-v">{fmt(item.raw)}</span></div>}
              {item.tx && <div><span className="vh-k">tx:</span> <span className="vh-v">{fmt(item.tx)}</span></div>}
            </article>
          );
        })}
      </div>
    </section>
  );
}
