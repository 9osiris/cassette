// strip credentials before anything hits disk
const HEADER_DENY = new Set([
  "authorization",
  "proxy-authorization",
  "x-api-key",
  "api-key",
]);

const QUERY_DENY = /^(api[_-]?key|key|token|secret|access[_-]?token)$/i;
const BODY_DENY = /token|api[_-]?key|secret|password/i;

// headers come back with the value replaced, keys kept so shape is visible
export function redactHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    out[k] = HEADER_DENY.has(k.toLowerCase()) ? "[redacted]" : v;
  }
  return out;
}

// ?api_key=abc in the url becomes ?api_key=[redacted]
export function redactQuery(path) {
  const q = path.indexOf("?");
  if (q === -1) return path;
  const params = new URLSearchParams(path.slice(q + 1));
  for (const k of [...params.keys()]) {
    if (QUERY_DENY.test(k)) params.set(k, "[redacted]");
  }
  return path.slice(0, q + 1) + params.toString();
}

// walks json, redacts string values under credential-looking keys
export function redactBody(value) {
  if (Array.isArray(value)) return value.map(redactBody);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] =
        BODY_DENY.test(k) && typeof v === "string" ? "[redacted]" : redactBody(v);
    }
    return out;
  }
  return value;
}
