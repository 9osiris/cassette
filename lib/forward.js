import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";

const HOP_BY_HOP = new Set([
  "connection",
  "transfer-encoding",
  "keep-alive",
  "upgrade",
  "proxy-authenticate",
  "proxy-authorization",
  "trailer",
  "te",
]);

// one raw upstream call, shared by record and replay-passthrough
export function forwardToUpstream(upstream, method, path, headers, bodyText) {
  return new Promise((resolve, reject) => {
    const base = new URL(upstream);
    const client = base.protocol === "https:" ? httpsRequest : httpRequest;
    const out = { ...headers };
    delete out["host"];
    delete out["content-length"];
    const req = client(
      base.origin + path,
      { method, headers: { ...out, host: base.host } },
      (upRes) => {
        const chunks = [];
        upRes.on("data", (c) => chunks.push(c));
        upRes.on("end", () => {
          const clean = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (!HOP_BY_HOP.has(k.toLowerCase())) clean[k] = v;
          }
          resolve({
            status: upRes.statusCode || 200,
            headers: clean,
            raw: Buffer.concat(chunks),
          });
        });
      }
    );
    req.on("error", reject);
    if (bodyText) req.write(bodyText);
    req.end();
  });
}
