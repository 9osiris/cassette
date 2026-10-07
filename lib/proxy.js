import { createServer } from "node:http";
import { forwardToUpstream } from "./forward.js";
import { buildExchange } from "./exchange.js";
import { loadTape, newTape, saveTape } from "./tape.js";

// record mode: plain http proxy, every exchange appended to the tape file
export function startRecord({
  tape,
  upstream,
  port,
  tapeDir,
  maxBody,
  onExchange,
}) {
  const saved = loadTape(tapeDir, tape) || newTape(tape, upstream);

  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const reqBody = Buffer.concat(chunks).toString("utf8");
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
        res.writeHead(up.status, up.headers);
        res.end(up.raw);
        const ex = buildExchange({
          method: req.method,
          path: req.url || "/",
          headers: req.headers,
          bodyText: reqBody,
          status: up.status,
          resHeaders: up.headers,
          raw: up.raw,
          started,
          maxBody,
        });
        saved.exchanges.push(ex);
        saveTape(tapeDir, saved);
        if (onExchange) onExchange(ex);
      } catch (err) {
        res.writeHead(502, { "content-type": "application/json" });
        res.end(
          JSON.stringify({ error: "cassette: upstream failed: " + err.message })
        );
      }
    });
  });

  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
