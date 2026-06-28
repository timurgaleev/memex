import React, { useState, useEffect } from "react";
import { api } from "../api";

interface FullStats {
  health: {
    embed_coverage_pct: number;
    embeddable_chunks: number;
    embedded_chunks: number;
    lag_seconds: number | null;
    queue_depth: number;
    failed_jobs_24h: number;
  } | null;
  counts: { documents: number; pages: number; chunks: number; grants: number } | null;
}

export function DashboardPage() {
  const [data, setData] = useState<FullStats>({ health: null, counts: null });
  const [error, setError] = useState("");

  useEffect(() => {
    const load = () => api.fullStats().then(setData).catch((e) => setError(String(e.message ?? e)));
    load();
    const interval = setInterval(load, 30000); // refresh every 30s
    return () => clearInterval(interval);
  }, []);

  const c = data.counts;
  const h = data.health;
  const pct = (n: number) => `${Math.round(n * 100)}%`;

  return (
    <>
      <h1 className="page-title">Dashboard</h1>
      {error && <div className="warning-bar">{error}</div>}

      <div className="metrics">
        <div className="metric">
          <div className="metric-value">{c?.documents ?? "—"}</div>
          <div className="metric-label">Documents</div>
        </div>
        <div className="metric">
          <div className="metric-value">{c?.pages ?? "—"}</div>
          <div className="metric-label">Pages</div>
        </div>
        <div className="metric">
          <div className="metric-value">{c?.chunks ?? "—"}</div>
          <div className="metric-label">Chunks</div>
        </div>
        <div className="metric">
          <div className="metric-value">{c?.grants ?? "—"}</div>
          <div className="metric-label">Tenant Grants</div>
        </div>
      </div>

      <h2 className="section-title">Brain Health</h2>
      <div className="health-panel" style={{ maxWidth: 360 }}>
        <div className="health-row">
          <span>Embed coverage</span>
          <span className="mono">{h ? `${pct(h.embed_coverage_pct)} (${h.embedded_chunks}/${h.embeddable_chunks})` : "—"}</span>
        </div>
        <div className="health-row">
          <span>Index lag</span>
          <span className="mono">{h ? (h.lag_seconds === null ? "n/a" : `${h.lag_seconds}s`) : "—"}</span>
        </div>
        <div className="health-row">
          <span>Queue depth</span>
          <span className="mono">{h?.queue_depth ?? "—"}</span>
        </div>
        <div className="health-row">
          <span style={{ color: h && h.failed_jobs_24h > 0 ? "var(--error)" : undefined }}>Failed jobs (24h)</span>
          <span className="mono">{h?.failed_jobs_24h ?? "—"}</span>
        </div>
      </div>
    </>
  );
}
