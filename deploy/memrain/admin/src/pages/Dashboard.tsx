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
  counts: { documents: number; pages: number; chunks: number } | null;
}

interface FeedEvent {
  agent: string;
  operation: string;
  latency_ms: number;
  status: string;
  timestamp: string;
}

export function DashboardPage() {
  const [data, setData] = useState<FullStats>({ health: null, counts: null });
  const [error, setError] = useState("");
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [sse, setSse] = useState<"connecting" | "connected" | "disconnected">("connecting");

  useEffect(() => {
    const load = () => api.fullStats().then(setData).catch((e) => setError(String(e.message ?? e)));
    load();
    const interval = setInterval(load, 30000); // refresh every 30s

    // Live activity feed (deferred #2). Browser EventSource auto-reconnects.
    const es = new EventSource("/admin/events");
    es.onopen = () => setSse("connected");
    es.onmessage = (e) => {
      try {
        setEvents((prev) => [JSON.parse(e.data) as FeedEvent, ...prev].slice(0, 50));
      } catch { /* ignore a malformed frame */ }
    };
    es.onerror = () => setSse("disconnected");

    return () => { clearInterval(interval); es.close(); };
  }, []);

  const timeAgo = (ts: string) => {
    const d = Date.now() - new Date(ts).getTime();
    if (d < 60000) return `${Math.floor(d / 1000)}s ago`;
    if (d < 3600000) return `${Math.floor(d / 60000)}m ago`;
    return `${Math.floor(d / 3600000)}h ago`;
  };

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

      <h2 className="section-title">
        Live Activity
        <span style={{ marginLeft: 8, fontSize: 10, color: sse === "connected" ? "var(--success)" : sse === "connecting" ? "var(--warning)" : "var(--error)" }}>
          {sse === "connected" ? "● connected" : sse === "connecting" ? "● connecting…" : "● disconnected"}
        </span>
      </h2>
      <div className="feed">
        {events.length === 0 ? (
          <div className="feed-empty">No requests yet. Tool calls appear here live.</div>
        ) : (
          <table>
            <thead>
              <tr><th>Agent</th><th>Operation</th><th>Latency</th><th>Status</th><th>Time</th></tr>
            </thead>
            <tbody>
              {events.map((e, i) => (
                <tr key={i}>
                  <td className="mono">{e.agent}</td>
                  <td className="mono">{e.operation}</td>
                  <td className="mono">{e.latency_ms} ms</td>
                  <td><span className={`badge badge-${e.status === "success" ? "success" : "error"}`}>{e.status}</span></td>
                  <td style={{ color: "var(--text-secondary)" }}>{timeAgo(e.timestamp)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
