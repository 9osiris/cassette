// tap -> junit xml, so ci runners that only speak junit can read node --test output
// usage: node --test --test-reporter=tap "test/*.test.js" | cassette junit --out report.xml
// zero dependencies, handles nested # Subtest blocks, failure diagnostics,
// skips, todos, and xml-unsafe characters in names and messages.

export function xmlEscape(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// xml 1.0 forbids most control chars; strip them so the output always parses
export function stripBadChars(s) {
  return String(s).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

// pull message, stack, and duration out of a tap diagnostics block
// (the yaml-ish lines between --- and ... after a failing test)
function parseDiag(lines) {
  const out = { message: "", stack: "", time: 0 };
  let section = null;
  let buf = [];
  const flush = () => {
    const text = buf.join("\n").trim();
    if (section === "error") out.message = text;
    if (section === "stack") out.stack = text;
    buf = [];
    section = null;
  };
  for (const raw of lines) {
    const dm = raw.match(/^duration_ms:\s*([\d.eE+-]+)/);
    if (dm) {
      out.time = Number(dm[1]) / 1000;
      continue;
    }
    // error: |- means a block follows; error: some text means inline value
    let kv = raw.match(/^(error|failure):\s*(.*?)\s*$/);
    if (kv) {
      flush();
      section = "error";
      if (kv[2] && !/^\|?-?$/.test(kv[2])) buf.push(kv[2]);
      continue;
    }
    kv = raw.match(/^stack:\s*(.*?)\s*$/);
    if (kv) {
      flush();
      section = "stack";
      if (kv[1] && !/^\|?-?$/.test(kv[1])) buf.push(kv[1]);
      continue;
    }
    // a new bare key ends the current block
    if (/^[a-zA-Z_][\w.]*:/.test(raw)) {
      flush();
      continue;
    }
    if (section) buf.push(raw);
  }
  flush();
  if (!out.message && !out.stack) out.message = lines.join("\n").trim();
  return out;
}

// walk tap text into a tree of suites; each # Subtest opens a frame,
// an "ok N - name" at the same indent with a matching name closes it,
// everything else indented deeper is a testcase
export function parseTap(text) {
  const root = { name: "tap", suites: [], cases: [] };
  const stack = [root];
  let lastCase = null;
  let diag = null;

  const flushDiag = () => {
    if (diag && lastCase) {
      const d = parseDiag(diag);
      lastCase.message = d.message;
      lastCase.stack = d.stack;
      lastCase.time = d.time;
    }
    diag = null;
  };

  for (const raw of String(text).split("\n")) {
    const line = raw.replace(/\r$/, "");
    let m = line.match(/^( *)# Subtest: (.*)$/);
    if (m) {
      flushDiag();
      lastCase = null;
      const frame = { name: m[2].trim(), suites: [], cases: [], indent: m[1].length };
      stack[stack.length - 1].suites.push(frame);
      stack.push(frame);
      continue;
    }
    m = line.match(/^( *)(not )?ok (\d+)( - (.*))?$/);
    if (m) {
      flushDiag();
      const indent = m[1].length;
      // node appends the directive to the name: "flaky one # SKIP reason"
      const name = (m[5] || "test " + m[3]).replace(/\s+#\s*(SKIP|TODO)\b.*$/i, "").trim();
      const c = {
        name,
        ok: !m[2],
        skipped: /#\s*SKIP\b/i.test(line),
        todo: /#\s*TODO\b/i.test(line),
        time: 0,
        message: "",
        stack: "",
      };
      const top = stack[stack.length - 1];
      if (top !== root && top.indent === indent && top.name === name) {
        if (top.cases.length > 0) {
          // classic nested summary line: the frame is done, drop it
          stack.pop();
        } else {
          // flat style (node 21+ tap reporter): the ok line IS the test,
          // its diagnostics follow the line instead of preceding it
          stack[stack.length - 2].cases.push(c);
          stack.pop();
        }
      } else {
        top.cases.push(c);
      }
      lastCase = c;
      continue;
    }
    if (/^ *--- *$/.test(line) && diag === null && lastCase) {
      diag = [];
      continue;
    }
    if (/^ *\.\.\. *$/.test(line) && diag !== null) {
      flushDiag();
      lastCase = null;
      continue;
    }
    if (diag !== null) {
      diag.push(line.trim());
      continue;
    }
    // plan lines (1..n), comments, and anything else: ignored
  }
  flushDiag();
  return root;
}

// a todo that failed is still just a todo to junit, not a failure
const isFailure = (c) => !c.ok && !c.todo;
const isSkipped = (c) => c.todo || (c.ok && c.skipped);

function suiteXml(frame) {
  const tests = frame.cases.length;
  const failures = frame.cases.filter(isFailure).length;
  const skipped = frame.cases.filter(isSkipped).length;
  const name = xmlEscape(stripBadChars(frame.name));
  let xml = `  <testsuite name="${name}" tests="${tests}" failures="${failures}" errors="0" skipped="${skipped}">\n`;
  for (const c of frame.cases) {
    const cname = xmlEscape(stripBadChars(c.name));
    const time = c.time ? ` time="${c.time.toFixed(3)}"` : "";
    if (c.ok && (c.skipped || c.todo)) {
      xml += `    <testcase name="${cname}" classname="${name}"${time}><skipped/></testcase>\n`;
    } else if (c.ok) {
      xml += `    <testcase name="${cname}" classname="${name}"${time}/>\n`;
    } else if (c.todo) {
      xml += `    <testcase name="${cname}" classname="${name}"${time}><skipped message="todo"/></testcase>\n`;
    } else {
      const msg = xmlEscape(stripBadChars(c.message || "test failed"));
      const body = xmlEscape(stripBadChars(c.stack || c.message || "test failed"));
      xml += `    <testcase name="${cname}" classname="${name}"${time}>\n`;
      xml += `      <failure message="${msg}">${body}</failure>\n`;
      xml += `    </testcase>\n`;
    }
  }
  xml += `  </testsuite>\n`;
  return xml;
}

// flatten nested suites: every frame with cases becomes its own testsuite
function collectSuites(frame, acc) {
  if (frame.cases.length) acc.push(frame);
  for (const s of frame.suites) collectSuites(s, acc);
  return acc;
}

export function tapToJunit(text) {
  const root = parseTap(text);
  const suites = collectSuites(root, []);
  const tests = suites.reduce((n, s) => n + s.cases.length, 0);
  const failures = suites.reduce((n, s) => n + s.cases.filter(isFailure).length, 0);
  const skipped = suites.reduce((n, s) => n + s.cases.filter(isSkipped).length, 0);
  let xml =
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<testsuites name="node --test" tests="${tests}" failures="${failures}" errors="0" skipped="${skipped}">\n`;
  for (const s of suites) xml += suiteXml(s);
  xml += `</testsuites>\n`;
  return xml;
}
