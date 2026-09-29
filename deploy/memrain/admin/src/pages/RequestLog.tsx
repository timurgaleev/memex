import React, { useState, useEffect } from "react";
import { api } from "../api";

interface Row {
  id: number;
  agent_name: string | null;
  operation: string;
  latency_ms: number | null;
  status: string;
  error_message: string | null;
  created_at: string;
}

export function RequestLogPage() {
  const [data, setData] = useState<{ page: number; per_page: number; total: number; rows: Row[] }>({
    page: 1, per_page: 25, total: 0, rows: [],
  });
  const [error, setError] = useState("");

  const load = (page: number) =>
    api.requests(page).then(setData).catch((e) => setError(String(e.message ?? e)));

  useEffect(() => { load(1); }, []);

  const pages = Math.max(1, Math.ceil(data.total / data.per_page));

  return (
    <>
      <h1 className="page-title">Request Log</h1>
      {error && <div className="warning-bar">{error}</div>}

      {data.rows.length === 0 ? (
        <div className="feed-empty">No request log entries yet.</div>
      ) : (
        <>
          <table>
            <thead>
              <tr><th>Time</th><th>Agent</th><th>Operation</th><th>Latency</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ color: "var(--text-secondary)" }}>{new Date(r.created_at).toLocaleString()}</td>
                  <td className="mono">{r.agent_name ?? "—"}</td>
                  <td className="mono">{r.operation}</td>
                  <td className="mono">{r.latency_ms == null ? "—" : `${r.latency_ms} ms`}</td>
                  <td><span className={`badge badge-${r.status === "success" ? "success" : "error"}`}>{r.status}</span></td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="pagination">
            <button disabled={data.page <= 1} onClick={() => load(data.page - 1)}>← Prev</button>
            <span>Page {data.page} / {pages} · {data.total} total</span>
            <button disabled={data.page >= pages} onClick={() => load(data.page + 1)}>Next →</button>
          </div>
        </>
      )}
    </>
  );
}
