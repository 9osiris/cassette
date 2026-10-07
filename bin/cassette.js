#!/usr/bin/env node
// cassette: record and replay openai-compatible api traffic
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startRecord } from "../lib/proxy.js";
import { startReplay } from "../lib/replay.js";
import { deleteTape, listTapes, loadTape } from "../lib/tape.js";
import { diffTapes } from "../lib/diff.js";
import { parseSize } from "../lib/sizes.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));

const HELP = `cassette ${pkg.version} - record and replay openai-compatible api traffic

usage:
  cassette record --tape NAME --upstream URL [--port 11434] [--tape-dir ./tapes] [--max-body SIZE]
  cassette replay --tape NAME [--port 11434] [--tape-dir ./tapes]
                         [--passthrough --upstream URL] [--chunk-delay MS] [--seed N] [-v]
  cassette list [--tape-dir ./tapes]
  cassette show NAME [--tape-dir ./tapes]
  cassette rm NAME [--tape-dir ./tapes]
  cassette diff OLD NEW [--tape-dir ./tapes] [-q]

record runs a proxy on 127.0.0.1 and saves every request/response pair,
with api keys and tokens redacted. replay serves the saved responses so
tests run offline and deterministic. unmatched requests get a 502 unless
--passthrough forwards them upstream and records the result. diff compares
two tapes exchange by exchange, handy after re-recording one: it pairs
requests by fingerprint and prints a unified diff of changed bodies.

examples:
  cassette record --tape gpt-smoke --upstream https://api.openai.com
  # point your client at http://127.0.0.1:11434, ctrl-c when done
  cassette record --tape big --upstream https://api.openai.com --max-body 2mb
  # bodies past the cap are stored truncated, the tape stays committable
  cassette replay --tape gpt-smoke
  OPENAI_BASE_URL=http://127.0.0.1:11434 pytest
`;

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      if (eq !== -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else if (i + 1 < argv.length && !argv[i + 1].startsWith("-")) {
        flags[a.slice(2)] = argv[++i];
      } else {
        flags[a.slice(2)] = true;
      }
    } else if (a.startsWith("-") && a.length === 2) {
      flags[a.slice(1)] = true;
    } else {
      flags._.push(a);
    }
  }
  return flags;
}

const die = (msg) => {
  console.error("cassette: " + msg);
  process.exit(1);
};

async function main() {
  const flags = parseArgs(process.argv.slice(2));
  const cmd = flags._[0];

  if (!cmd || flags.help || flags.h) {
    console.log(HELP);
    return;
  }
  if (flags.version || flags.v) {
    console.log(pkg.version);
    return;
  }

  const tapeDir = flags["tape-dir"] || "./tapes";
  const port = Number(flags.port || 11434);

  if (cmd === "record") {
    const tape = flags.tape;
    const upstream = flags.upstream;
    if (!tape) die("--tape NAME is required");
    if (!upstream) die("--upstream URL is required");
    let maxBody;
    if (flags["max-body"] != null) {
      try {
        maxBody = parseSize(flags["max-body"]);
      } catch (err) {
        die("--max-body: " + err.message);
      }
    }
    const server = await startRecord({
      tape,
      upstream,
      port,
      tapeDir,
      maxBody,
      onExchange: (ex) =>
        console.log("recorded", ex.request.method, ex.request.path),
    });
    console.log(
      `recording to ${tapeDir}/${tape}.json, proxying ${upstream} on 127.0.0.1:${port}`
    );
    console.log("ctrl-c to stop and save");
    const stop = () => {
      server.close(() => process.exit(0));
      setTimeout(() => process.exit(0), 500).unref();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }

  if (cmd === "replay") {
    const tape = flags.tape;
    if (!tape) die("--tape NAME is required");
    if (flags.passthrough && !flags.upstream)
      die("--passthrough needs --upstream URL");
    await startReplay({
      tape,
      port,
      tapeDir,
      passthrough: !!flags.passthrough,
      upstream: flags.upstream,
      chunkDelay: Number(flags["chunk-delay"] || 0),
      seed: flags.seed != null ? Number(flags.seed) : null,
      verbose: !!(flags.v || flags.verbose),
    });
    console.log(`replaying ${tapeDir}/${tape}.json on 127.0.0.1:${port}`);
    if (flags.passthrough) console.log("passthrough on, misses hit upstream");
    return;
  }

  if (cmd === "list") {
    const names = listTapes(tapeDir);
    if (!names.length) {
      console.log("no tapes in " + tapeDir);
      return;
    }
    for (const n of names) {
      const t = loadTape(tapeDir, n);
      console.log(n + "  " + (t ? t.exchanges.length : 0) + " exchanges");
    }
    return;
  }

  if (cmd === "show") {
    const name = flags._[1];
    if (!name) die("cassette show NAME");
    const t = loadTape(tapeDir, name);
    if (!t) die("no tape named " + name);
    const models = new Set();
    for (const e of t.exchanges) {
      const b = e.request.body;
      if (b && typeof b === "object" && b.model) models.add(b.model);
    }
    console.log("tape:      " + t.name);
    console.log("recorded:  " + t.created_at);
    console.log("upstream:  " + (t.upstream || "unknown"));
    console.log("exchanges: " + t.exchanges.length);
    console.log("models:    " + ([...models].join(", ") || "none seen"));
    for (const e of t.exchanges) {
      console.log(
        `  ${e.request.method} ${e.request.path} -> ${e.response.status}` +
          (e.response.streamed ? " (stream)" : "") +
          ` ${e.duration_ms}ms`
      );
    }
    return;
  }

  if (cmd === "rm") {
    const name = flags._[1];
    if (!name) die("no tape named " + name);
    if (!deleteTape(tapeDir, name)) die("no tape named " + name);
    console.log("deleted " + name);
    return;
  }

  if (cmd === "diff") {
    const oldName = flags._[1];
    const newName = flags._[2];
    if (!oldName || !newName) die("cassette diff OLD NEW");
    const a = loadTape(tapeDir, oldName);
    const b = loadTape(tapeDir, newName);
    if (!a) die("no tape named " + oldName);
    if (!b) die("no tape named " + newName);
    const quiet = !!(flags.q || flags.quiet);
    const rows = diffTapes(a, b);
    const changed = rows.filter((r) => r.status !== "same").length;
    if (!quiet) {
      rows.forEach((r, i) => {
        console.log(
          "  [" + i + "] " + r.label + ": " + r.status + (r.note ? " (" + r.note + ")" : "")
        );
        if (r.diff) for (const l of r.diff) console.log("      " + l);
      });
    }
    console.log(changed ? `${changed} of ${rows.length} exchanges differ` : "tapes identical");
    if (changed) process.exit(1);
    return;
  }

  die("unknown command " + cmd + " (try --help)");
}

main().catch((err) => die(err.message));
