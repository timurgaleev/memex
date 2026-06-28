import React, { useState } from "react";
import { api } from "../api";

// Trust model: the bootstrap token is NEVER stored in browser JS state (no
// localStorage/sessionStorage, no React state past the submit). After a
// successful POST /admin/login it lives only in the HttpOnly cookie the server
// sets. Magic-link URLs use single-use server nonces, not the token itself.
export function LoginPage({ onLogin }: { onLogin: () => void }) {
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setLoading(true);
    try {
      await api.login(token);
      setToken(""); // don't persist — the cookie is the session now
      onLogin();
    } catch {
      setError("Invalid token.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-box">
        <div className="login-logo">memex</div>

        <div style={{
          background: "rgba(136, 170, 255, 0.08)",
          border: "1px solid rgba(136, 170, 255, 0.2)",
          borderRadius: 8,
          padding: "14px 16px",
          marginBottom: 20,
          fontSize: 13,
          lineHeight: 1.5,
          color: "var(--text-secondary)",
        }}>
          <div style={{ fontWeight: 600, color: "var(--text-primary)", marginBottom: 6 }}>
            🔒 This is a protected dashboard
          </div>
          Ask your AI agent for the admin login link:
          <div style={{
            background: "rgba(0,0,0,0.3)",
            borderRadius: 6,
            padding: "8px 12px",
            marginTop: 8,
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: "#88aaff",
            wordBreak: "break-all",
          }}>
            "Give me the memex admin login link"
          </div>
          <div style={{ marginTop: 8, fontSize: 12, color: "var(--text-muted)" }}>
            Each link is single-use. Your agent generates a fresh one each time.
          </div>
        </div>

        <details style={{ marginBottom: 16 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, color: "var(--text-muted)" }}>
            Or paste bootstrap token manually
          </summary>
          <form onSubmit={handleSubmit} style={{ marginTop: 12 }}>
            <div style={{ marginBottom: 12 }}>
              <input
                type="password"
                placeholder="Admin Token"
                value={token}
                onChange={(e) => setToken(e.target.value)}
              />
            </div>
            <button className="btn btn-primary" style={{ width: "100%" }} disabled={loading}>
              {loading ? "Authenticating..." : "Submit"}
            </button>
            {error && <div className="login-error">{error}</div>}
          </form>
        </details>
      </div>
    </div>
  );
}
