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

// bodies past the cap shrink to a truncation marker so tapes stay small and
// committable. streamed bodies keep the first chunks that fit, then a marker
// chunk so the replayed stream is still valid sse. json bodies become a
// marker object, plain strings get a hard cut with a note.
function capBody(value, streamed, maxBody) {
  const size = JSON.stringify(value).length;
  if (size <= maxBody) return value;
  if (streamed) {
    const chunks = [];
    let bytes = 0;
    for (const c of value) {
      if (bytes + c.length + 4 > maxBody && chunks.length) break;
      chunks.push(c);
      bytes += c.length + 4;
    }
    chunks.push("data: [cassette-truncated]");
    return chunks;
  }
  if (typeof value === "string")
    return (
      value.slice(0, maxBody) +
      "\n[cassette: truncated, " +
      size +
      " bytes total]"
    );
  return { cassette_truncated: true, original_bytes: size };
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
  maxBody,
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
  const reqBody = safeJson(bodyText);
  return {
    request: {
      method,
      path: redactQuery(path),
      headers: redactHeaders(headers),
      body:
        maxBody && maxBody > 0
          ? capBody(reqBody, false, maxBody)
          : reqBody,
      fingerprint: fingerprintRequest(method, path, bodyText),
    },
    response: {
      status,
      headers: outHeaders,
      streamed,
      body:
        maxBody && maxBody > 0
          ? capBody(stored, streamed, maxBody)
          : stored,
    },
    duration_ms: Date.now() - started,
    recorded_at: new Date().toISOString(),
  };
}
