import { createServer } from "node:http";
import { serializeSse } from "./sse.js";
import { findExchange, loadTape, saveTape } from "./tape.js";
import { forwardToUpstream } from "./forward.js";
import { buildExchange } from "./exchange.js";
import { nextChunkDelay, seededRng } from "./rng.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// replay mode: serve recorded responses, no upstream needed. unmatched
// requests 502 unless --passthrough forwards them and records the result.
export function startReplay({
  tape,
  port,
  tapeDir,
  passthrough,
  upstream,
  chunkDelay,
  seed,
  verbose,
}) {
  const saved = loadTape(tapeDir, tape);
  if (!saved) throw new Error("no tape named " + tape);

  // one rng for the whole replay run, so --seed gives identical timing
  // across restarts of the same tape
  const rng = seed != null ? seededRng(seed) : null;

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const reqBody = Buffer.concat(chunks).toString("utf8");
      const ex = findExchange(saved, req.method, req.url || "/", reqBody);
      if (ex) {
        if (verbose) console.log("hit", req.method, ex.request.path);
        const r = ex.response;
        res.writeHead(r.status, r.headers);
        if (r.streamed && chunkDelay > 0) {
          for (const c of r.body) {
            res.write(c + "\n\n");
            await sleep(nextChunkDelay(rng, chunkDelay));
          }
          res.end();
        } else if (r.streamed) {
          res.end(serializeSse(r.body));
        } else {
          res.end(typeof r.body === "string" ? r.body : JSON.stringify(r.body));
        }
        return;
      }
      if (passthrough && upstream) {
        const started = Date.now();
        const headers = { ...req.headers };
        delete headers["host"];
        try {
          const up = await forwardToUpstream(
            upstream,
            req.method,
            req.url || "/",
            headers,
            reqBody
          );
          const fresh = buildExchange({
            method: req.method,
            path: req.url || "/",
            headers: req.headers,
            bodyText: reqBody,
            status: up.status,
            resHeaders: up.headers,
            raw: up.raw,
            started,
          });
          saved.exchanges.push(fresh);
          saveTape(tapeDir, saved);
          if (verbose) console.log("passthrough, recorded", req.method, req.url);
          res.writeHead(up.status, up.headers);
          res.end(up.raw);
        } catch (err) {
          res.writeHead(502, { "content-type": "application/json" });
          res.end(
            JSON.stringify({
              error: "cassette: passthrough failed: " + err.message,
            })
          );
        }
        return;
      }
      if (verbose) console.log("miss", req.method, req.url);
      res.writeHead(502, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error:
            "cassette: no recorded exchange matches " +
            req.method +
            " " +
            (req.url || "/"),
          hint: "re-record with `cassette record`, or replay with --passthrough --upstream URL",
        })
      );
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
