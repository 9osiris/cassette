import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactBody, redactHeaders, redactQuery } from "../lib/redact.js";
import { parseSse, serializeSse } from "../lib/sse.js";
import { nextChunkDelay, seededRng } from "../lib/rng.js";
import {
  canonical,
  deleteTape,
  findExchange,
  fingerprintRequest,
  listTapes,
  loadTape,
  newTape,
  saveTape,
} from "../lib/tape.js";
import { startRecord } from "../lib/proxy.js";
import { startReplay } from "../lib/replay.js";
import { buildExchange } from "../lib/exchange.js";
import { parseSize } from "../lib/sizes.js";

const dir = () => mkdtempSync(join(tmpdir(), "cassette-"));

// close a server even with lingering keep-alive connections
function shut(s) {
  return new Promise((r) => {
    s.closeAllConnections();
    s.close(r);
  });
}

// small helper: one http call, resolves {status, headers, text}
function call(port, path, { method = "POST", headers = {}, body = "" } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path,
        method,
        headers: { connection: "close", ...headers },
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () =>
          resolve({
            status: res.statusCode,
            headers: res.headers,
            text: Buffer.concat(chunks).toString("utf8"),
          })
        );
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

// fake openai-ish upstream: json chat completions + an sse stream
function fakeUpstream() {
  return createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      if (req.url === "/v1/chat/completions" && !body.includes("stream")) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            id: "chatcmpl-1",
            choices: [{ message: { content: "hello back" } }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          })
        );
      } else if (body.includes("stream")) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        res.end(
          'data: {"delta":{"content":"hi"}}\n\ndata: {"delta":{"content":" there"}}\n\ndata: [DONE]\n\n'
        );
      } else if (req.url === "/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "fake-1" }] }));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "nope" }));
      }
    });
  });
}

test("canonical json ignores key order and spacing", () => {
  assert.equal(
    canonical({ b: 1, a: [2, 1] }),
    canonical({ a: [2, 1], b: 1 })
  );
});

test("fingerprint stable across formatting, changes with model", () => {
  const a = fingerprintRequest(
    "POST",
    "/v1/chat/completions",
    '{"model":"x","messages":[]}'
  );
  const b = fingerprintRequest(
    "POST",
    "/v1/chat/completions",
    '{ "messages" : [], "model" : "x" }'
  );
  const c = fingerprintRequest(
    "POST",
    "/v1/chat/completions",
    '{"model":"y","messages":[]}'
  );
  assert.equal(a, b);
  assert.notEqual(a, c);
});

test("redactHeaders strips authorization", () => {
  const out = redactHeaders({
    authorization: "Bearer sk-secret",
    "content-type": "application/json",
  });
  assert.equal(out.authorization, "[redacted]");
  assert.equal(out["content-type"], "application/json");
});

test("redactQuery redacts api_key param only", () => {
  assert.equal(
    redactQuery("/v1/x?api_key=abc&other=1"),
    "/v1/x?api_key=%5Bredacted%5D&other=1"
  );
  assert.equal(redactQuery("/v1/x"), "/v1/x");
});

test("redactBody redacts nested credential fields", () => {
  const out = redactBody({
    api_key: "sk-1",
    nested: { password: "hunter2", keep: "yes" },
    list: [{ token: "t" }],
  });
  assert.equal(out.api_key, "[redacted]");
  assert.equal(out.nested.password, "[redacted]");
  assert.equal(out.nested.keep, "yes");
  assert.equal(out.list[0].token, "[redacted]");
});

test("sse round trip", () => {
  const raw = 'data: {"a":1}\n\ndata: [DONE]\n\n';
  assert.equal(serializeSse(parseSse(raw)), raw);
});

test("record and replay a json chat completion", async () => {
  const t = dir();
  const up = fakeUpstream();
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const upPort = up.address().port;

  const proxy = await startRecord({
    tape: "smoke",
    upstream: `http://127.0.0.1:${upPort}`,
    port: 0,
    tapeDir: t,
  });
  const pPort = proxy.address().port;

  const reqBody = JSON.stringify({
    model: "fake-1",
    messages: [{ role: "user", content: "hi" }],
  });
  const r1 = await call(pPort, "/v1/chat/completions", {
    headers: { authorization: "Bearer sk-live-secret", "content-type": "application/json" },
    body: reqBody,
  });
  assert.equal(r1.status, 200);
  assert.match(r1.text, /hello back/);
  await shut(proxy);
  await shut(up);

  const saved = loadTape(t, "smoke");
  assert.equal(saved.exchanges.length, 1);
  const ex = saved.exchanges[0];
  assert.equal(ex.request.headers.authorization, "[redacted]");
  assert.equal(ex.response.status, 200);
  assert.equal(ex.response.streamed, false);
  assert.equal(ex.response.body.choices[0].message.content, "hello back");

  const replay = await startReplay({ tape: "smoke", port: 0, tapeDir: t });
  const r2 = await call(replay.address().port, "/v1/chat/completions", {
    headers: { "content-type": "application/json" },
    body: reqBody,
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.text, r1.text);
  await shut(replay);
  rmSync(t, { recursive: true, force: true });
});

test("record and replay a streaming response", async () => {
  const t = dir();
  const up = fakeUpstream();
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const upPort = up.address().port;

  const proxy = await startRecord({
    tape: "stream",
    upstream: `http://127.0.0.1:${upPort}`,
    port: 0,
    tapeDir: t,
  });
  const pPort = proxy.address().port;
  const r1 = await call(pPort, "/v1/chat/completions", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-1", stream: true, messages: [] }),
  });
  assert.equal(r1.status, 200);
  assert.match(r1.headers["content-type"], /text\/event-stream/);
  await shut(proxy);
  await shut(up);

  const saved = loadTape(t, "stream");
  assert.equal(saved.exchanges[0].response.streamed, true);
  assert.deepEqual(saved.exchanges[0].response.body, [
    'data: {"delta":{"content":"hi"}}',
    'data: {"delta":{"content":" there"}}',
    "data: [DONE]",
  ]);

  assert.throws(() => startReplay({ tape: "smoke-x", port: 0, tapeDir: t }), /no tape/);

  const replay2 = await startReplay({ tape: "stream", port: 0, tapeDir: t });
  const r2 = await call(replay2.address().port, "/v1/chat/completions", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ stream: true, model: "fake-1", messages: [] }),
  });
  assert.equal(parseSse(r2.text).join("|"), parseSse(r1.text).join("|"));
  await shut(replay2);
  rmSync(t, { recursive: true, force: true });
});

test("replay 502s on unmatched request", async () => {
  const t = dir();
  saveTape(t, newTape("tiny", null));
  const replay = await startReplay({ tape: "tiny", port: 0, tapeDir: t });
  const r = await call(replay.address().port, "/v1/chat/completions", {
    body: JSON.stringify({ model: "nope" }),
  });
  assert.equal(r.status, 502);
  assert.match(r.text, /no recorded exchange/);
  await shut(replay);
  rmSync(t, { recursive: true, force: true });
});

test("replay --passthrough records misses", async () => {
  const t = dir();
  saveTape(t, newTape("pt", null));
  const up = fakeUpstream();
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const upPort = up.address().port;

  const replay = await startReplay({
    tape: "pt",
    port: 0,
    tapeDir: t,
    passthrough: true,
    upstream: `http://127.0.0.1:${upPort}`,
  });
  const rPort = replay.address().port;
  const r1 = await call(rPort, "/v1/models", { method: "GET" });
  assert.equal(r1.status, 200);
  assert.match(r1.text, /fake-1/);
  await shut(replay);
  await shut(up);

  const saved = loadTape(t, "pt");
  assert.equal(saved.exchanges.length, 1);
  assert.equal(saved.exchanges[0].request.method, "GET");

  // second run replays it without upstream
  const replay2 = await startReplay({ tape: "pt", port: 0, tapeDir: t });
  const r2 = await call(replay2.address().port, "/v1/models", { method: "GET" });
  assert.equal(r2.text, r1.text);
  await shut(replay2);
  rmSync(t, { recursive: true, force: true });
});

test("same request twice replays two recorded responses in order", async () => {
  const t = dir();
  const tape = newTape("order", null);
  const fp = fingerprintRequest("POST", "/", "x");
  const mk = (n) => ({
    request: {
      method: "POST",
      path: "/",
      headers: {},
      body: "x",
      fingerprint: fp,
    },
    response: { status: 200, headers: {}, streamed: false, body: { n } },
    duration_ms: 1,
    recorded_at: new Date().toISOString(),
  });
  tape.exchanges.push(mk(1), mk(2));
  saveTape(t, tape);

  const replay = await startReplay({ tape: "order", port: 0, tapeDir: t });
  const p = replay.address().port;
  const r1 = await call(p, "/", { body: "x" });
  const r2 = await call(p, "/", { body: "x" });
  assert.match(r1.text, /"n":1/);
  assert.match(r2.text, /"n":2/);
  await shut(replay);
  rmSync(t, { recursive: true, force: true });
});

test("findExchange returns null when nothing matches", () => {
  const tape = newTape("e", null);
  assert.equal(findExchange(tape, "GET", "/nope", ""), null);
});

test("tape store list and delete", () => {
  const t = dir();
  assert.deepEqual(listTapes(t), []);
  saveTape(t, newTape("b", null));
  saveTape(t, newTape("a", null));
  assert.deepEqual(listTapes(t), ["a", "b"]);
  assert.equal(deleteTape(t, "a"), true);
  assert.equal(deleteTape(t, "a"), false);
  assert.deepEqual(listTapes(t), ["b"]);
  rmSync(t, { recursive: true, force: true });
});

test("cli list show rm", async () => {
  const t = dir();
  const { execFileSync } = await import("node:child_process");
  const bin = new URL("../bin/cassette.js", import.meta.url).pathname;
  const run = (args) =>
    execFileSync(process.execPath, [bin, ...args], { encoding: "utf8" });

  saveTape(t, newTape("demo", "http://x"));
  assert.match(run(["list", "--tape-dir", t]), /demo\s+0 exchanges/);
  assert.match(run(["show", "demo", "--tape-dir", t]), /exchanges: 0/);
  assert.match(run(["rm", "demo", "--tape-dir", t]), /deleted demo/);
  assert.deepEqual(listTapes(t), []);
  rmSync(t, { recursive: true, force: true });
});

test("seeded rng is deterministic per seed", () => {
  const a = seededRng(7);
  const b = seededRng(7);
  const seqA = [a(), a(), a(), a(), a()];
  const seqB = [b(), b(), b(), b(), b()];
  assert.deepEqual(seqA, seqB);
  assert.notEqual(seededRng(8)(), seqA[0]);
  for (const v of seqA) {
    assert.ok(v >= 0 && v < 1);
  }
});

test("nextChunkDelay jitters 0.5x to 1.5x, flat without rng", () => {
  const rng = seededRng(42);
  for (let i = 0; i < 50; i++) {
    const d = nextChunkDelay(rng, 20);
    assert.ok(d >= 10 && d <= 30, "delay " + d + " out of range");
  }
  assert.equal(nextChunkDelay(null, 20), 20);
});

// tape with a 4-chunk stream, built by hand so no upstream needed
function timedTape(t) {
  const body = JSON.stringify({ model: "x", stream: true });
  const tape = newTape("timed", null);
  tape.exchanges.push({
    request: {
      method: "POST",
      path: "/v1/chat/completions",
      headers: {},
      body,
      fingerprint: fingerprintRequest("POST", "/v1/chat/completions", body),
    },
    response: {
      status: 200,
      headers: { "content-type": "text/event-stream" },
      streamed: true,
      body: ["data: a", "data: b", "data: c", "data: [DONE]"],
    },
    duration_ms: 1,
    recorded_at: new Date().toISOString(),
  });
  saveTape(t, tape);
}

// arrival timestamps of each sse chunk on the client side
function streamTimes(port, body) {
  return new Promise((resolve, reject) => {
    const times = [];
    const req = request(
      {
        host: "127.0.0.1",
        port,
        path: "/v1/chat/completions",
        method: "POST",
        headers: { connection: "close", "content-type": "application/json" },
      },
      (res) => {
        res.on("data", () => times.push(Date.now()));
        res.on("end", () => resolve(times));
      }
    );
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

const chunkDeltas = async (port, body) => {
  const t = await streamTimes(port, body);
  return t.slice(1).map((x, i) => x - t[i]);
};

test("replay --seed jitters chunk timing within bounds, content intact", async () => {
  const t = dir();
  timedTape(t);
  const body = JSON.stringify({ model: "x", stream: true });

  const replay = await startReplay({
    tape: "timed",
    port: 0,
    tapeDir: t,
    chunkDelay: 30,
    seed: 7,
  });
  const port = replay.address().port;
  const text = (await call(port, "/v1/chat/completions", { body })).text;
  assert.equal(parseSse(text).join("|"), "data: a|data: b|data: c|data: [DONE]");

  const deltas = await chunkDeltas(port, body);
  assert.equal(deltas.length, 3);
  for (const d of deltas) {
    assert.ok(d >= 12 && d <= 48, "chunk gap " + d + "ms outside jitter band");
  }
  // jitter is real, not a flat delay
  assert.ok(new Set(deltas).size > 1, "expected varied gaps, got " + deltas);
  await shut(replay);
  rmSync(t, { recursive: true, force: true });
});

test("replay without --seed keeps a flat chunk delay", async () => {
  const t = dir();
  timedTape(t);
  const body = JSON.stringify({ model: "x", stream: true });

  const replay = await startReplay({
    tape: "timed",
    port: 0,
    tapeDir: t,
    chunkDelay: 30,
  });
  const deltas = await chunkDeltas(replay.address().port, body);
  for (const d of deltas) {
    assert.ok(Math.abs(d - 30) <= 8, "flat gap drifted: " + d + "ms");
  }
  await shut(replay);
  rmSync(t, { recursive: true, force: true });
});

import {
  bodyEqual,
  comparePair,
  diffTapes,
  formatDiff,
  lineDiff,
  responseLines,
} from "../lib/diff.js";

// build a tape from [method, path, requestBody, responseBody] specs
function diffTape(name, specs) {
  const tape = newTape(name, null);
  for (const [method, path, reqBody, respBody] of specs) {
    const bodyText =
      typeof reqBody === "string" ? reqBody : JSON.stringify(reqBody);
    let stored = reqBody;
    try {
      stored = JSON.parse(bodyText);
    } catch {
      // plain text, keep as-is
    }
    tape.exchanges.push({
      request: {
        method,
        path,
        headers: {},
        body: stored,
        fingerprint: fingerprintRequest(method, path, bodyText),
      },
      response: {
        status: 200,
        headers: {},
        streamed: Array.isArray(respBody),
        body: respBody,
      },
      duration_ms: 1,
      recorded_at: new Date().toISOString(),
    });
  }
  return tape;
}

test("lineDiff marks changed lines", () => {
  const ops = lineDiff(["a", "b", "c"], ["a", "x", "c"]);
  assert.deepEqual(
    ops.map((o) => o.t),
    [" ", "-", "+", " "]
  );
  assert.equal(
    ops.find((o) => o.t === "-").s,
    "b"
  );
  assert.equal(
    ops.find((o) => o.t === "+").s,
    "x"
  );
});

test("responseLines pretty-prints json with sorted keys", () => {
  assert.deepEqual(responseLines({ b: 1, a: 2 }), [
    "{",
    '  "a": 2,',
    '  "b": 1',
    "}",
  ]);
});

test("bodyEqual ignores key order", () => {
  assert.ok(bodyEqual({ a: 1, b: 2 }, { b: 2, a: 1 }));
  assert.ok(!bodyEqual({ a: 1 }, { a: 2 }));
});

test("diffTapes calls identical tapes all same", () => {
  const specs = [
    ["POST", "/v1/chat/completions", { model: "x" }, { ok: true, n: 1 }],
  ];
  const rows = diffTapes(diffTape("a", specs), diffTape("b", specs));
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "same");
});

test("diffTapes reports a changed response body with a unified diff", () => {
  const req = ["POST", "/v1/chat/completions", { model: "x" }];
  const a = diffTape("a", [[...req, { content: "hello back" }]]);
  const b = diffTape("b", [[...req, { content: "hello there" }]]);
  const rows = diffTapes(a, b);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, "response");
  assert.equal(rows[0].note, "body differs");
  const lines = rows[0].diff.join("\n");
  assert.match(lines, /-.*"content": "hello back"/);
  assert.match(lines, /\+.*"content": "hello there"/);
});

test("diffTapes flags status changes", () => {
  const req = ["POST", "/v1/chat/completions", { model: "x" }];
  const a = diffTape("a", [[...req, { ok: true }]]);
  const b = diffTape("b", [[...req, { ok: true }]]);
  b.exchanges[0].response.status = 429;
  const rows = diffTapes(a, b);
  assert.equal(rows[0].status, "response");
  assert.match(rows[0].note, /status 200 -> 429/);
});

test("diffTapes pairs by fingerprint across added and removed calls", () => {
  const mk = (body) => ["POST", "/v1/chat/completions", body, { ok: true }];
  const a = diffTape("a", [mk({ model: "x", q: 1 }), mk({ model: "x", q: 2 })]);
  const b = diffTape("b", [mk({ model: "x", q: 1 }), mk({ model: "x", q: 3 })]);
  const rows = diffTapes(a, b);
  assert.deepEqual(
    rows.map((r) => r.status),
    ["same", "only-in-old", "only-in-new"]
  );
});

test("diffTapes diffs streamed chunk bodies", () => {
  const req = ["POST", "/v1/chat/completions", { model: "x", stream: true }];
  const a = diffTape("a", [[...req, ["data: a", "data: [DONE]"]]]);
  const b = diffTape("b", [[...req, ["data: b", "data: [DONE]"]]]);
  const rows = diffTapes(a, b);
  assert.equal(rows[0].status, "response");
  const lines = rows[0].diff.join("\n");
  assert.match(lines, /- data: a/);
  assert.match(lines, /\+ data: b/);
});

test("formatDiff truncates long diffs", () => {
  const ops = lineDiff(
    Array.from({ length: 100 }, (_, i) => "old " + i),
    Array.from({ length: 100 }, (_, i) => "new " + i)
  );
  const lines = formatDiff(ops, 2, 10);
  assert.ok(lines.some((l) => l.includes("truncated")));
});

test("parseSize accepts bytes and kb/mb/gb", () => {  assert.equal(parseSize("512"), 512);
  assert.equal(parseSize("512b"), 512);
  assert.equal(parseSize("4kb"), 4096);
  assert.equal(parseSize("4KB"), 4096);
  assert.equal(parseSize("2mb"), 2 * 1024 * 1024);
  assert.equal(parseSize("1.5mb"), Math.floor(1.5 * 1024 * 1024));
  assert.equal(parseSize("1gb"), 1024 ** 3);
  assert.throws(() => parseSize("big"), /bad size/);
  assert.throws(() => parseSize("10tb"), /bad size/);
});

test("buildExchange leaves small bodies alone with a cap set", () => {
  const ex = buildExchange({
    method: "POST",
    path: "/v1/chat/completions",
    headers: {},
    bodyText: '{"model":"x"}',
    status: 200,
    resHeaders: { "content-type": "application/json" },
    raw: Buffer.from('{"ok":true}'),
    started: Date.now(),
    maxBody: 1024,
  });
  assert.deepEqual(ex.response.body, { ok: true });
  assert.deepEqual(ex.request.body, { model: "x" });
});

test("buildExchange truncates oversized json bodies to a marker", () => {
  const big = { content: "a".repeat(5000) };
  const ex = buildExchange({
    method: "POST",
    path: "/v1/chat/completions",
    headers: {},
    bodyText: JSON.stringify(big),
    status: 200,
    resHeaders: { "content-type": "application/json" },
    raw: Buffer.from(JSON.stringify(big)),
    started: Date.now(),
    maxBody: 1000,
  });
  assert.equal(ex.response.body.cassette_truncated, true);
  assert.equal(ex.response.body.original_bytes, JSON.stringify(big).length);
  // the fingerprint still comes from the full body, so replay matching works
  assert.equal(
    ex.request.fingerprint,
    fingerprintRequest("POST", "/v1/chat/completions", JSON.stringify(big))
  );
});

test("buildExchange truncates streamed bodies to first chunks plus a marker", () => {
  const chunks = [
    'data: {"delta":{"content":"hi"}}',
    'data: {"delta":{"content":" there"}}',
    'data: {"delta":{"content":"!"}}',
    "data: [DONE]",
  ];
  const ex = buildExchange({
    method: "POST",
    path: "/v1/chat/completions",
    headers: {},
    bodyText: '{"stream":true}',
    status: 200,
    resHeaders: { "content-type": "text/event-stream" },
    raw: Buffer.from(chunks.map((c) => c + "\n\n").join("")),
    started: Date.now(),
    maxBody: 60,
  });
  assert.equal(ex.response.streamed, true);
  const body = ex.response.body;
  assert.ok(Array.isArray(body));
  assert.equal(body[body.length - 1], "data: [cassette-truncated]");
  assert.ok(JSON.stringify(body).length <= 200, "chunks blew past the cap");
  // still serializes to valid sse, marker is the last chunk
  const sse = serializeSse(body);
  assert.equal(parseSse(sse).at(-1), "data: [cassette-truncated]");
});

test("buildExchange truncates plain string bodies with a note", () => {
  const text = "x".repeat(3000);
  const ex = buildExchange({
    method: "GET",
    path: "/v1/models",
    headers: {},
    bodyText: "",
    status: 200,
    resHeaders: { "content-type": "text/plain" },
    raw: Buffer.from(text),
    started: Date.now(),
    maxBody: 500,
  });
  assert.ok(typeof ex.response.body === "string");
  // json-stringified the body is 3002 bytes (3000 chars plus the quotes)
  assert.match(ex.response.body, /\[cassette: truncated, 3002 bytes total\]/);
  assert.ok(ex.response.body.length < text.length);
});

test("record --max-body proxies the full body but stores it truncated", async () => {
  const t = dir();
  const up = fakeUpstream();
  await new Promise((r) => up.listen(0, "127.0.0.1", r));
  const upPort = up.address().port;

  const proxy = await startRecord({
    tape: "capped",
    upstream: `http://127.0.0.1:${upPort}`,
    port: 0,
    tapeDir: t,
    maxBody: 40,
  });
  const pPort = proxy.address().port;
  const r1 = await call(pPort, "/v1/chat/completions", {
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "fake-1", messages: [] }),
  });
  assert.equal(r1.status, 200);
  // client still sees the full upstream response while recording
  assert.match(r1.text, /hello back/);
  await shut(proxy);
  await shut(up);

  const saved = loadTape(t, "capped");
  assert.equal(saved.exchanges.length, 1);
  const ex = saved.exchanges[0];
  assert.equal(ex.response.body.cassette_truncated, true);
  assert.ok(ex.response.body.original_bytes > 40);
  // the fingerprint used the full body, matching still works
  assert.equal(
    ex.request.fingerprint,
    fingerprintRequest(
      "POST",
      "/v1/chat/completions",
      JSON.stringify({ model: "fake-1", messages: [] })
    )
  );
  rmSync(t, { recursive: true, force: true });
});

test("cli record --max-body rejects a bad size", async () => {
  const t = dir();
  const { execFileSync } = await import("node:child_process");
  const bin = new URL("../bin/cassette.js", import.meta.url).pathname;
  try {
    execFileSync(
      process.execPath,
      [bin, "record", "--tape", "x", "--upstream", "http://x", "--max-body", "huge", "--tape-dir", t],
      { encoding: "utf8" }
    );
    assert.fail("expected a non-zero exit");
  } catch (e) {
    assert.equal(e.status, 1);
    assert.match(String(e.stderr), /--max-body: bad size/);
  }
  rmSync(t, { recursive: true, force: true });
});

test("replay serves a truncated json exchange without breaking", async () => {
  const t = dir();
  const body = JSON.stringify({ model: "x" });
  const tape = newTape("cap", null);
  tape.exchanges.push({
    request: {
      method: "POST",
      path: "/v1/chat/completions",
      headers: {},
      body: { model: "x" },
      fingerprint: fingerprintRequest("POST", "/v1/chat/completions", body),
    },
    response: {
      status: 200,
      headers: {},
      streamed: false,
      body: { cassette_truncated: true, original_bytes: 9000 },
    },
    duration_ms: 1,
    recorded_at: new Date().toISOString(),
  });
  saveTape(t, tape);

  const replay = await startReplay({ tape: "cap", port: 0, tapeDir: t });
  const r = await call(replay.address().port, "/v1/chat/completions", {
    body,
  });
  assert.equal(r.status, 200);
  assert.match(r.text, /cassette_truncated/);
  await shut(replay);
  rmSync(t, { recursive: true, force: true });
});
test("cli diff exits 1 on differences, 0 when identical", async () => {
  const t = dir();
  const { execFileSync } = await import("node:child_process");
  const bin = new URL("../bin/cassette.js", import.meta.url).pathname;
  const req = ["POST", "/v1/chat/completions", { model: "x" }];
  saveTape(t, diffTape("old", [[...req, { ok: true }]]));
  saveTape(t, diffTape("new", [[...req, { ok: false }]]));
  const run = (args) => {
    try {
      return {
        code: 0,
        out: execFileSync(process.execPath, [bin, ...args], {
          encoding: "utf8",
        }),
      };
    } catch (e) {
      return { code: e.status, out: String(e.stdout), err: String(e.stderr) };
    }
  };
  const r1 = run(["diff", "old", "new", "--tape-dir", t]);
  assert.equal(r1.code, 1);
  assert.match(r1.out, /1 of 1 exchanges differ/);
  assert.match(r1.out, /"ok": false/);
  const r2 = run(["diff", "old", "old", "--tape-dir", t, "-q"]);
  assert.equal(r2.code, 0);
  assert.match(r2.out, /tapes identical/);
  const r3 = run(["diff", "old", "missing", "--tape-dir", t]);
  assert.equal(r3.code, 1);
  assert.match(r3.err, /no tape named missing/);
  rmSync(t, { recursive: true, force: true });
});
