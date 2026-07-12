import React, { useState, useEffect } from "react";
import { api } from "../api";
import { CredentialsSection } from "./Credentials";

// memex's provisioning model is tenant `sources` + JWT-subject `source_grants`.
// This page lists the grants and drives the A2 endpoints: register a source,
// provision a subject grant, revoke one.

interface Grant {
  sub: string;
  source_id: string;
  federated_read: string[] | null;
}

interface AgentConfig {
  mcp_url: string;
  name: string;
  sub: string;
  scope: { write: string | null; read: string[] };
  snippets: Record<string, string>;
}

const SNIPPET_LABELS: Array<[string, string]> = [
  ["claude-code", "Claude Code"],
  ["claude-desktop", "Claude Desktop"],
  ["chatgpt", "ChatGPT"],
  ["cursor", "Cursor"],
  ["json", "Raw JSON"],
];

export function AgentsPage() {
  const [grants, setGrants] = useState<Grant[]>([]);
  const [error, setError] = useState("");
  const [modal, setModal] = useState<null | "source" | "grant">(null);
  const [configSub, setConfigSub] = useState<string | null>(null);

  const load = () =>
    api.grants()
      .then((r: { grants: Grant[] }) => setGrants(r.grants))
      .catch((e) => setError(String(e.message ?? e)));

  useEffect(() => { load(); }, []);

  const revoke = async (sub: string) => {
    if (!confirm(`Revoke the grant for subject "${sub}"? They fall back to the un-provisioned redacted read.`)) return;
    try {
      await api.revokeGrant(sub);
      await load();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    }
  };

  return (
    <>
      <h1 className="page-title">Agents</h1>
      {error && <div className="warning-bar">{error}</div>}

      <div className="filter-bar">
        <button className="btn btn-primary" onClick={() => setModal("source")}>Register source</button>
        <button className="btn btn-secondary" onClick={() => setModal("grant")}>Provision grant</button>
      </div>

      {grants.length === 0 ? (
        <div className="feed-empty">No grants yet. Register a tenant source, then provision a subject.</div>
      ) : (
        <table>
          <thead>
            <tr><th>Subject</th><th>Write source</th><th>Federated read</th><th></th></tr>
          </thead>
          <tbody>
            {grants.map((g) => (
              <tr key={g.sub}>
                <td className="mono">{g.sub}</td>
                <td><span className="badge badge-write">{g.source_id}</span></td>
                <td>{(g.federated_read ?? []).map((s, i) => (
                  <span key={`${s}:${i}`} className="badge badge-read" style={{ marginRight: 4 }}>{s}</span>
                ))}</td>
                <td style={{ textAlign: "right" }}>
                  <button className="btn btn-secondary" style={{ fontSize: 12, marginRight: 6 }} onClick={() => setConfigSub(g.sub)}>Config</button>
                  <button className="btn btn-danger" style={{ fontSize: 12 }} onClick={() => revoke(g.sub)}>Revoke</button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <CredentialsSection setError={setError} />

      {modal === "source" && <RegisterSourceModal onClose={() => setModal(null)} onDone={load} setError={setError} />}
      {modal === "grant" && <ProvisionGrantModal onClose={() => setModal(null)} onDone={load} setError={setError} />}
      {configSub && <ConfigDrawer sub={configSub} onClose={() => setConfigSub(null)} setError={setError} />}
    </>
  );
}

// Onboarding config drawer: fetches the per-subject MCP client snippets and
// shows a copy-paste block for each common client. Read-only — the token in
// every snippet is a placeholder the operator swaps for the subject's own.
function ConfigDrawer({ sub, onClose, setError }: { sub: string; onClose: () => void; setError: (s: string) => void }) {
  const [cfg, setCfg] = useState<AgentConfig | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    api.agentConfig(sub)
      .then((r: AgentConfig) => setCfg(r))
      .catch((e) => setError(String((e as Error).message ?? e)));
  }, [sub]);

  const copy = async (key: string, text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      /* clipboard blocked — the operator can still select the text manually */
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" style={{ maxWidth: 720 }} onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Onboarding config — {sub}</div>
        {!cfg ? (
          <div className="feed-empty">Loading…</div>
        ) : (
          <>
            <div style={{ marginBottom: 12, fontSize: 13 }}>
              <div>MCP URL: <span className="mono">{cfg.mcp_url}</span></div>
              <div>
                Scope: <span className="badge badge-write">{cfg.scope.write ?? "read-only"}</span>
                {cfg.scope.read.map((s, i) => (
                  <span key={`${s}:${i}`} className="badge badge-read" style={{ marginLeft: 4 }}>{s}</span>
                ))}
              </div>
            </div>
            {SNIPPET_LABELS.filter(([k]) => cfg.snippets[k]).map(([key, label]) => (
              <div key={key} style={{ marginBottom: 14 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                  <label>{label}</label>
                  <button className="btn btn-secondary" style={{ fontSize: 12 }} onClick={() => copy(key, cfg.snippets[key]!)}>
                    {copied === key ? "Copied" : "Copy"}
                  </button>
                </div>
                <pre className="mono" style={{ margin: 0, padding: 8, overflowX: "auto", fontSize: 12, whiteSpace: "pre" }}>
                  {cfg.snippets[key]}
                </pre>
              </div>
            ))}
          </>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onClose}>Close</button>
        </div>
      </div>
    </div>
  );
}

function RegisterSourceModal({ onClose, onDone, setError }: { onClose: () => void; onDone: () => void; setError: (s: string) => void }) {
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      await api.registerSource(id.trim(), name.trim() || undefined);
      onDone();
      onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Register tenant source</div>
        <div style={{ marginBottom: 12 }}>
          <label>Source id</label>
          <input value={id} onChange={(e) => setId(e.target.value)} placeholder="acme" />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label>Display name (optional)</label>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder="Acme Corp" />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || id.trim() === ""} onClick={submit}>
            {busy ? "Registering..." : "Register"}
          </button>
        </div>
      </div>
    </div>
  );
}

function ProvisionGrantModal({ onClose, onDone, setError }: { onClose: () => void; onDone: () => void; setError: (s: string) => void }) {
  const [sub, setSub] = useState("");
  const [source, setSource] = useState("");
  const [read, setRead] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    setBusy(true);
    try {
      const readIds = read.split(",").map((s) => s.trim()).filter(Boolean);
      await api.grant(sub.trim(), source.trim(), readIds.length > 0 ? readIds : undefined);
      onDone();
      onClose();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-title">Provision subject grant</div>
        <div style={{ marginBottom: 12 }}>
          <label>JWT subject</label>
          <input value={sub} onChange={(e) => setSub(e.target.value)} placeholder="user-123" />
        </div>
        <div style={{ marginBottom: 12 }}>
          <label>Write source id</label>
          <input value={source} onChange={(e) => setSource(e.target.value)} placeholder="acme" />
        </div>
        <div style={{ marginBottom: 16 }}>
          <label>Federated read ids (comma-separated, optional)</label>
          <input value={read} onChange={(e) => setRead(e.target.value)} placeholder="acme, shared" />
        </div>
        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button className="btn btn-secondary" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" disabled={busy || sub.trim() === "" || source.trim() === ""} onClick={submit}>
            {busy ? "Provisioning..." : "Provision"}
          </button>
        </div>
      </div>
    </div>
  );
}
