/**
 * CORS for the reputation read API only.
 * Allows one Pages origin, single-label preview subdomains of that project,
 * and http://localhost / http://127.0.0.1 on any port.
 * Never matches *.pages.dev. Never sets credentials.
 */

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export function createReputationCors(policy) {
  const pagesOrigin = normalizeOrigin(policy?.pagesOrigin);
  const previewHost = String(policy?.previewHost || "").toLowerCase();
  const localHosts = new Set((policy?.localHosts || []).map((host) => String(host).toLowerCase()));
  return function reputationCorsHeaders(req) {
    const headers = {
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "GET,OPTIONS",
      vary: "Origin",
    };
    const origin = req.headers?.origin;
    if (origin && reputationOriginAllowed(String(origin), { pagesOrigin, previewHost, localHosts })) {
      headers["access-control-allow-origin"] = String(origin);
    }
    return headers;
  };
}

export function reputationOriginAllowed(origin, policy) {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.pathname !== "/" && url.pathname !== "") return false;
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:" && policy.localHosts.has(host)) return true;
  if (url.protocol !== "https:") return false;
  if (policy.pagesOrigin && url.origin === policy.pagesOrigin) return true;
  const suffix = `.${policy.previewHost}`;
  if (!policy.previewHost || !host.endsWith(suffix)) return false;
  const label = host.slice(0, -suffix.length);
  return LABEL.test(label);
}

function normalizeOrigin(value) {
  if (!value) return "";
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}
