const BASE = "";

// Trust model: the admin UI does NOT cache the bootstrap token in browser JS
// state. On 401, redirect to login — no auto-reauth, no localStorage. The
// HttpOnly cookie set by /admin/login is the only session credential.
async function apiFetch(path: string, options?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, {
    ...options,
    credentials: "same-origin",
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (res.status === 401) {
    window.location.hash = "#login";
    throw new Error("Unauthorized");
  }
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error((body as { error?: string }).error || `HTTP ${res.status}`);
  }
  return res.json();
}

// memex A2 endpoints (http/admin-api.ts). The reference's separate
// stats/health/oauth-client endpoints collapse onto memex's full-stats +
// source_grants provisioning surface; the feed/calibration endpoints (B3) are
// added with their pages.
export const api = {
  login: (token: string) => apiFetch("/admin/login", { method: "POST", body: JSON.stringify({ token }) }),
  signOutEverywhere: () => apiFetch("/admin/api/sign-out-everywhere", { method: "POST" }),
  fullStats: () => apiFetch("/admin/api/full-stats"),
  grants: () => apiFetch("/admin/api/grants"),
  registerSource: (id: string, name?: string) =>
    apiFetch("/admin/api/sources", { method: "POST", body: JSON.stringify({ id, name }) }),
  grant: (sub: string, source: string, read?: string[]) =>
    apiFetch("/admin/api/grants", { method: "POST", body: JSON.stringify({ sub, source, ...(read ? { read } : {}) }) }),
  revokeGrant: (sub: string) =>
    apiFetch("/admin/api/revoke-grant", { method: "POST", body: JSON.stringify({ sub }) }),
  requests: (page = 1) => apiFetch(`/admin/api/requests?page=${page}`),
  jobsWatch: () => apiFetch("/admin/api/jobs/watch"),
  calibrationProfile: () => apiFetch("/admin/api/calibration/profile"),
};
