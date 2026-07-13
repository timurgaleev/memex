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

// memex A2 endpoints (http/admin-api.ts). Separate stats/health/oauth-client
// endpoints collapse onto memex's full-stats + credentials surface; the
// feed/calibration endpoints (B3) are added with their pages.
export const api = {
  login: (token: string) => apiFetch("/admin/login", { method: "POST", body: JSON.stringify({ token }) }),
  signOutEverywhere: () => apiFetch("/admin/api/sign-out-everywhere", { method: "POST" }),
  fullStats: () => apiFetch("/admin/api/full-stats"),
  agents: () => apiFetch("/admin/api/agents"),
  mintApiKey: (name: string) =>
    apiFetch("/admin/api/api-keys", { method: "POST", body: JSON.stringify({ name }) }),
  revokeApiKey: (name: string) =>
    apiFetch("/admin/api/api-keys/revoke", { method: "POST", body: JSON.stringify({ name }) }),
  registerClient: (payload: Record<string, unknown>) =>
    apiFetch("/admin/api/register-client", { method: "POST", body: JSON.stringify(payload) }),
  updateClientTtl: (client_id: string, token_ttl: number | null) =>
    apiFetch("/admin/api/update-client-ttl", { method: "POST", body: JSON.stringify({ client_id, token_ttl }) }),
  revokeClient: (client_id: string) =>
    apiFetch("/admin/api/revoke-client", { method: "POST", body: JSON.stringify({ client_id }) }),
  requests: (page = 1) => apiFetch(`/admin/api/requests?page=${page}`),
  jobsWatch: () => apiFetch("/admin/api/jobs/watch"),
  calibrationProfile: () => apiFetch("/admin/api/calibration/profile"),
};
