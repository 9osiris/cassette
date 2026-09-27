import { parseSse } from "./sse.js";
import { redactBody, redactHeaders, redactQuery } from "./redact.js";
import { fingerprintRequest } from "./tape.js";

function safeJson(text) {
  try {
    return redactBody(JSON.parse(text));
  } catch {
    return text;
  }
}

// one recorded request/response pair, everything sensitive redacted
export function buildExchange({
  method,
  path,
  headers,
  bodyText,
  status,
  resHeaders,
  raw,
  started,
}) {
  const ctype = String(resHeaders["content-type"] || "");
  const streamed = ctype.includes("text/event-stream");
  const text = raw.toString("utf8");
  let stored = text;
  if (streamed) {
    stored = parseSse(text);
  } else {
    try {
      stored = redactBody(JSON.parse(text));
    } catch {
      // plain text body, keep as-is
    }
  }
  const outHeaders = { ...resHeaders };
  delete outHeaders["content-length"]; // recomputed on replay
  return {
    request: {
      method,
      path: redactQuery(path),
      headers: redactHeaders(headers),
      body: safeJson(bodyText),
      fingerprint: fingerprintRequest(method, path, bodyText),
    },
    response: {
      status,
      headers: outHeaders,
      streamed,
      body: stored,
    },
    duration_ms: Date.now() - started,
    recorded_at: new Date().toISOString(),
  };
}
