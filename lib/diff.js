// compare two tapes exchange by exchange and describe what changed.
// requests pair up by fingerprint in record order, so re-recording a tape
// with an extra call in the middle doesn't shift every comparison.
import { canonical } from "./tape.js";

// json with sorted keys and indentation, so key order never shows up as a diff
function stablePretty(value, level) {
  const pad = "  ".repeat(level);
  const inner = "  ".repeat(level + 1);
  if (Array.isArray(value)) {
    if (!value.length) return "[]";
    return "[\n" + value.map((v) => inner + stablePretty(v, level + 1)).join(",\n") + "\n" + pad + "]";
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).sort();
    if (!keys.length) return "{}";
    return "{\n" + keys.map((k) => inner + JSON.stringify(k) + ": " + stablePretty(value[k], level + 1)).join(",\n") + "\n" + pad + "}";
  }
  return JSON.stringify(value);
}

// a response body (json object, sse chunk array, or plain text) as diffable lines
export function responseLines(body) {
  if (Array.isArray(body)) return body.map(String);
  if (body && typeof body === "object") return stablePretty(body, 0).split("\n");
  return String(body == null ? "" : body).split("\n");
}

// same body on both sides, no diff needed
export function bodyEqual(a, b) {
  return canonical(a) === canonical(b);
}

// lcs line diff. n*m table is fine, tapes are small.
export function lineDiff(a, b) {
  const n = a.length, m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) { ops.push({ t: " ", s: a[i] }); i++; j++; }
    else if (dp[i + 1][j] >= dp[i][j + 1]) { ops.push({ t: "-", s: a[i] }); i++; }
    else { ops.push({ t: "+", s: b[j] }); j++; }
  }
  while (i < n) ops.push({ t: "-", s: a[i++] });
  while (j < m) ops.push({ t: "+", s: b[j++] });
  return ops;
}

// group ops into hunks with a few context lines, cap runaway diffs
export function formatDiff(ops, ctx = 2, maxLines = 40) {
  const out = [];
  let start = 0, shown = 0;
  while (start < ops.length) {
    let end = start;
    while (end < ops.length && ops[end].t === " ") end++;
    if (end === ops.length) break;
    const lo = Math.max(start, end - ctx), hi = end;
    let nxt = hi;
    while (nxt < ops.length && ops[nxt].t !== " ") nxt++;
    const hunk = ops.slice(lo, Math.min(nxt + ctx, ops.length));
    out.push("@@");
    for (const o of hunk) {
      if (shown >= maxLines) {
        out.push("... (diff truncated, " + (ops.length - shown) + " more lines)");
        return out;
      }
      out.push((o.t === " " ? "  " : o.t + " ") + o.s);
      if (o.t !== " ") shown++;
    }
    start = nxt + ctx;
  }
  return out;
}

// compare two matched exchanges. null means identical.
export function comparePair(ea, eb) {
  if (ea.request.method !== eb.request.method || ea.request.path !== eb.request.path)
    return { status: "request", note: "method or path differs" };
  if (ea.response.status !== eb.response.status)
    return { status: "response", note: "status " + ea.response.status + " -> " + eb.response.status };
  if (ea.response.streamed !== eb.response.streamed)
    return { status: "response", note: "streamed flag differs" };
  if (bodyEqual(ea.response.body, eb.response.body)) return null;
  return {
    status: "response",
    note: "body differs",
    diff: formatDiff(lineDiff(responseLines(ea.response.body), responseLines(eb.response.body))),
  };
}

const label = (e) => e.request.method + " " + e.request.path + " -> " + e.response.status;

// pair exchanges across tapes by request fingerprint, in record order.
// anything left over is reported as only-in-one-side.
export function diffTapes(ta, tb) {
  const rows = [];
  const pool = new Map();
  for (const e of tb.exchanges) {
    const fp = e.request.fingerprint;
    if (!pool.has(fp)) pool.set(fp, []);
    pool.get(fp).push(e);
  }
  for (const e of ta.exchanges) {
    const q = pool.get(e.request.fingerprint);
    if (q && q.length) {
      const other = q.shift();
      const c = comparePair(e, other);
      rows.push({ label: label(e), status: c ? c.status : "same", note: c ? c.note : null, diff: c ? c.diff : null });
    } else {
      rows.push({ label: label(e), status: "only-in-old", note: null, diff: null });
    }
  }
  for (const q of pool.values())
    for (const e of q) rows.push({ label: label(e), status: "only-in-new", note: null, diff: null });
  return rows;
}
