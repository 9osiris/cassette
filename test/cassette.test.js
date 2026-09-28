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
