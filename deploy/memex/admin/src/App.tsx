import React, { useState, useEffect } from "react";
import { LoginPage } from "./pages/Login";
import { DashboardPage } from "./pages/Dashboard";
import { AgentsPage } from "./pages/Agents";
import { RequestLogPage } from "./pages/RequestLog";
import { JobsWatchPage } from "./pages/JobsWatch";
import { CalibrationPage } from "./pages/Calibration";
import { api } from "./api";

type Page = "login" | "dashboard" | "agents" | "log" | "jobs" | "calibration";
const PAGES = ["login", "dashboard", "agents", "log", "jobs", "calibration"] as const;

function getPage(): Page {
  const hash = window.location.hash.replace("#", "") || "dashboard";
  return (PAGES as readonly string[]).includes(hash) ? (hash as Page) : "dashboard";
}

export function App() {
  const [page, setPage] = useState<Page>(getPage);

  useEffect(() => {
    const onHash = () => setPage(getPage());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const navigate = (p: Page) => {
    window.location.hash = p;
    setPage(p);
  };

  if (page === "login") {
    return <LoginPage onLogin={() => navigate("dashboard")} />;
  }

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
        {page === "dashboard" && <DashboardPage />}
        {page === "agents" && <AgentsPage />}
        {page === "log" && <RequestLogPage />}
        {page === "jobs" && <JobsWatchPage />}
        {page === "calibration" && <CalibrationPage />}
      </main>
    </div>
  );
}
