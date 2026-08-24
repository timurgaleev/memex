import React, { useState, useEffect } from "react";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { AgentsPage } from "./pages/Agents";
import { RequestLogPage } from "./pages/RequestLog";
import { JobsWatchPage } from "./pages/JobsWatch";
import { CalibrationPage } from "./pages/Calibration";
import { api } from "./api";

type Page = "login" | "dashboard" | "agents" | "log" | "jobs" | "calibration";

interface PendingResume {
  handle?: string;
  redirect_to: string | null;
  resource?: string | null;
  client_id?: string | null;
  client_name?: string | null;
  redirect_uri?: string | null;
  scope?: string | null;
}
const PAGES = ["login", "dashboard", "agents", "log", "jobs", "calibration"] as const;

/** The origin a callback would deliver the code to — the part worth reading. */
function originOf(uri?: string | null): string | null {
  if (!uri) return null;
  try {
    return new URL(uri).origin;
  } catch {
    return uri;
  }
}

function getPage(): Page {
  const hash = window.location.hash.replace("#", "") || "dashboard";
  return (PAGES as readonly string[]).includes(hash) ? (hash as Page) : "dashboard";
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);
  const [pending, setPending] = useState<PendingResume | null>(null);
  const [pendingError, setPendingError] = useState("");

  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  // An OAuth connect that bounced here for sign-in leaves its /authorize target
  // parked server-side. It is never followed automatically — a cross-site page
  // can plant one — so it is shown as a confirmation naming who would receive
  // the credential.
  useEffect(() => {
    if (page === "login") return;
    api.pendingResume()
      .then((r: PendingResume) => { if (r?.redirect_to) setPending(r); })
      .catch(() => { /* not signed in — the panel appears after login */ });
  }, [page]);

  const navigate = (p: Page) => {
    window.location.hash = p;
    setPage(p);
  };

  if (page === "login") {
    return <LoginPage onLogin={() => navigate("dashboard")} />;
  }

  // The click IS the consent: it mints a one-time approval bound to this
  // request, which /authorize demands on top of the session. The returned path
  // is server-validated to a local /authorize; the shape check keeps the
  // navigation same-origin regardless.
  const confirmResume = async () => {
    if (!pending?.handle) return;
    setPendingError("");
    try {
      // The handle names the request on screen: if the parked one changed since
      // it was rendered, the server refuses rather than approving the new one.
      const { redirect_to } = await api.approveResume(pending.handle) as { redirect_to?: string };
      if (redirect_to?.startsWith("/") && !redirect_to.startsWith("//")) window.location.assign(redirect_to);
      else setPendingError("The server returned no destination — start the connection again.");
    } catch (e) {
      // A refused approval must say so; the request it refused may still be
      // pending, so re-read it rather than leaving a stale panel on screen.
      setPendingError(e instanceof Error ? e.message : "Approval failed.");
      api.pendingResume()
        .then((r: PendingResume) => setPending(r?.redirect_to ? r : null))
        .catch(() => setPending(null));
    }
  };

  const dismissResume = async () => {
    setPending(null);
    setPendingError("");
    await api.dismissResume().catch(() => { /* the cookie expires on its own */ });
  };

  const handleSignOutEverywhere = async () => {
    if (!confirm("Sign out every active admin session, including other browsers and tabs? Each one will need to re-authenticate via a fresh magic link.")) {
      return;
    }
    try {
      await api.signOutEverywhere();
    } catch {
      // even on failure, push to login — the cookie is likely already invalid
    }
    navigate("login");
  };

  return (
    <div className="app">
      <nav className="sidebar">
        <div className="sidebar-logo">memex</div>
        <div className="sidebar-nav">
          <a className={`nav-item ${page === "dashboard" ? "active" : ""}`} onClick={() => navigate("dashboard")}>
            Dashboard
          </a>
          <a className={`nav-item ${page === "agents" ? "active" : ""}`} onClick={() => navigate("agents")}>
            Agents
          </a>
          <a className={`nav-item ${page === "log" ? "active" : ""}`} onClick={() => navigate("log")}>
            Request Log
          </a>
          <a className={`nav-item ${page === "jobs" ? "active" : ""}`} onClick={() => navigate("jobs")}>
            Jobs Watch
          </a>
          <a className={`nav-item ${page === "calibration" ? "active" : ""}`} onClick={() => navigate("calibration")}>
            Calibration
          </a>
        </div>
        <div style={{ marginTop: "auto", padding: "16px 12px", borderTop: "1px solid #1e1e2e" }}>
          <button
            onClick={handleSignOutEverywhere}
            className="btn btn-secondary"
            style={{ width: "100%", fontSize: 12 }}
            title="Revoke every active admin session — every browser, every tab"
          >
            Sign out everywhere
          </button>
        </div>
      </nav>
      <main className="main">
        {pending && (
          <div style={{
            background: "rgba(136, 170, 255, 0.08)",
            border: "1px solid rgba(136, 170, 255, 0.25)",
            borderRadius: 8,
            padding: "16px 18px",
            marginBottom: 20,
            fontSize: 13,
            lineHeight: 1.6,
          }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              Send an authorization code to{" "}
              <span style={{ fontFamily: "var(--font-mono)" }}>
                {originOf(pending.redirect_uri) || "an unregistered callback"}
              </span>?
            </div>
            <div style={{ color: "var(--text-secondary)" }}>
              {/* The callback leads, because that is who actually receives the
                  credential; the name is client-supplied and can be anything. */}
              Requested by <span style={{ fontFamily: "var(--font-mono)" }}>
                {(pending.client_name || pending.client_id || "unknown client").slice(0, 60)}
              </span>
              {pending.scope ? `, granting "${pending.scope}"` : ""}
              {pending.resource ? `, for audience ${pending.resource}` : ""}. Full callback:{" "}
              <span style={{ fontFamily: "var(--font-mono)", wordBreak: "break-all" }}>
                {pending.redirect_uri}
              </span>. Continue only if you started this.
            </div>
            {pendingError && (
              <div style={{ marginTop: 10, color: "#ff8888" }}>{pendingError}</div>
            )}
            <div style={{ marginTop: 12, display: "flex", gap: 8 }}>
              <button className="btn btn-primary" onClick={confirmResume}>Continue</button>
              <button className="btn btn-secondary" onClick={dismissResume}>Not now</button>
            </div>
          </div>
        )}
        {page === "dashboard" && <DashboardPage />}
        {page === "agents" && <AgentsPage />}
        {page === "log" && <RequestLogPage />}
        {page === "jobs" && <JobsWatchPage />}
        {page === "calibration" && <CalibrationPage />}
      </main>
    </div>
  );
}
