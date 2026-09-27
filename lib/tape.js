import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { redactBody, redactQuery } from "./redact.js";

// canonical json so key order and spacing never change the fingerprint
export function canonical(value) {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") {
    return (
      "{" +
      Object.keys(value)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(value[k]))
        .join(",") +
      "}"
    );
  }
  return JSON.stringify(value);
}

// short stable id for a request. query and body are redacted first so two
// requests that differ only by api key still match.
export function fingerprintRequest(method, path, bodyText) {
  const cleanPath = redactQuery(path || "/");
  let body = bodyText || "";
  try {
    body = canonical(redactBody(JSON.parse(bodyText)));
  } catch {
    // not json, hash the raw text
  }
  return createHash("sha256")
    .update(method + "\n" + cleanPath + "\n" + body)
    .digest("hex")
    .slice(0, 16);
}

export function tapePath(dir, name) {
  return join(dir, name + ".json");
}

export function loadTape(dir, name) {
  const p = tapePath(dir, name);
  if (!existsSync(p)) return null;
  return JSON.parse(readFileSync(p, "utf8"));
}

export function saveTape(dir, tape) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(tapePath(dir, tape.name), JSON.stringify(tape, null, 2) + "\n");
}

export function deleteTape(dir, name) {
  const p = tapePath(dir, name);
  if (!existsSync(p)) return false;
  unlinkSync(p);
  return true;
}

export function listTapes(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -5))
    .sort();
}

// unused exchanges match first, so the same request twice in a row replays
// the first two recorded responses in order. falls back to any match.
export function findExchange(tape, method, path, bodyText) {
  const fp = fingerprintRequest(method, path, bodyText);
  let ex = tape.exchanges.find(
    (e) => !e.used && e.request.fingerprint === fp
  );
  if (!ex) ex = tape.exchanges.find((e) => e.request.fingerprint === fp);
  if (ex) ex.used = true;
  return ex || null;
}

export function newTape(name, upstream) {
  return {
    name,
    cassette: 1,
    created_at: new Date().toISOString(),
    upstream: upstream || null,
    exchanges: [],
  };
}
