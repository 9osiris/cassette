import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTap, tapToJunit } from "../lib/junit.js";

const PASS = `TAP version 13
# Subtest: test/sizes.test.js
    ok 1 - parses plain bytes
    ok 2 - parses kilobytes
    1..2
ok 1 - test/sizes.test.js
1..1
# tests 1
# pass 1
# fail 0
`;

const FAIL = `TAP version 13
# Subtest: test/sizes.test.js
    ok 1 - parses plain bytes
    not ok 2 - parses megabytes
      ---
      duration_ms: 4.321
      failureType: 'testFailure'
      error: |-
        expected 1048576 to equal 1000000
      code: 'ERR_ASSERTION'
      stack: |-
        TestContext.<anonymous> (file:///x/test.js:10:3)
      ...
    1..2
not ok 1 - test/sizes.test.js
1..1
# tests 1
# pass 0
# fail 1
`;

const NESTED = `TAP version 13
# Subtest: test/all.test.js
    # Subtest: sizes
        ok 1 - parses plain bytes
        1..1
    ok 1 - sizes
    # Subtest: rng
        ok 1 - seeded runs repeat
        not ok 2 - handles zero
          ---
          duration_ms: 0.5
          error: division by zero
          ...
        1..2
    ok 2 - rng
    1..2
ok 1 - test/all.test.js
1..1
`;

test("converts a passing run", () => {
  const xml = tapToJunit(PASS);
  assert.match(xml, /<testsuites name="node --test" tests="2" failures="0" errors="0" skipped="0">/);
  assert.match(xml, /<testsuite name="test\/sizes\.test\.js" tests="2" failures="0"/);
  assert.match(xml, /<testcase name="parses plain bytes" classname="test\/sizes\.test\.js"\/>/);
});

test("failing test becomes a failure with the error message", () => {
  const xml = tapToJunit(FAIL);
  assert.match(xml, /tests="2" failures="1"/);
  assert.match(xml, /<failure message="expected 1048576 to equal 1000000">/);
  assert.match(xml, /TestContext\.&lt;anonymous&gt;/);
  assert.match(xml, /time="0\.004"/);
});

test("nested subtests become separate testsuites", () => {
  const xml = tapToJunit(NESTED);
  assert.match(xml, /<testsuite name="sizes" tests="1" failures="0"/);
  assert.match(xml, /<testsuite name="rng" tests="2" failures="1"/);
  assert.match(xml, /<failure message="division by zero">/);
});

test("skips and todos become skipped elements", () => {
  const tap = `TAP version 13
# Subtest: test/x.test.js
    ok 1 - flaky one # SKIP not today
    not ok 2 - unfinished # TODO
    1..2
ok 1 - test/x.test.js
1..1
`;
  const xml = tapToJunit(tap);
  assert.match(xml, /skipped="2"/);
  assert.match(xml, /<testcase name="flaky one"[^>]*><skipped\/><\/testcase>/);
  assert.match(xml, /<testcase name="unfinished"[^>]*><skipped message="todo"\/><\/testcase>/);
});

test("escapes xml in names and messages", () => {
  const tap = `TAP version 13
# Subtest: test/a&b.test.js
    not ok 1 - 1 < 2 & "quotes"
      ---
      error: got <bad> & stuff
      ...
    1..1
not ok 1 - test/a&b.test.js
1..1
`;
  const xml = tapToJunit(tap);
  assert.match(xml, /name="test\/a&amp;b\.test\.js"/);
  assert.match(xml, /name="1 &lt; 2 &amp; &quot;quotes&quot;"/);
  assert.match(xml, /message="got &lt;bad&gt; &amp; stuff"/);
});

test("strips control characters that xml forbids", () => {
  const tap = "TAP version 13\n# Subtest: test/x.test.js\n    ok 1 - bell\x07here\n    1..1\nok 1 - test/x.test.js\n1..1\n";
  const xml = tapToJunit(tap);
  assert.doesNotMatch(xml, /\x07/);
  assert.match(xml, /name="bellhere"/);
});

// node 21+ tap reporter emits flat pairs: # Subtest then the ok line at the
// same indent, diagnostics after the line instead of nested cases
const FLAT = `# Subtest: converts a passing run
ok 1 - converts a passing run
  ---
  duration_ms: 3.01
  type: 'test'
  ...
# Subtest: failing one
not ok 2 - failing one
  ---
  duration_ms: 1.2
  failureType: 'testFailure'
  error: |-
    boom happened
  code: 'ERR_ASSERTION'
  ...
# Subtest: skipped one
ok 3 - skipped one # SKIP not today
  ---
  duration_ms: 0.1
  ...
`;

test("handles the flat node 21+ tap style", () => {
  const xml = tapToJunit(FLAT);
  assert.match(xml, /tests="3" failures="1" errors="0" skipped="1"/);
  assert.match(xml, /<testcase name="converts a passing run" classname="tap" time="0\.003"\/>/);
  assert.match(xml, /<failure message="boom happened">/);
  assert.match(xml, /<testcase name="skipped one"[^>]*><skipped\/><\/testcase>/);
});

test("parseTap keeps the tree shape", () => {
  const root = parseTap(NESTED);
  assert.equal(root.suites.length, 1);
  const file = root.suites[0];
  assert.equal(file.suites.length, 2);
  assert.equal(file.suites[1].cases.length, 2);
  assert.equal(file.suites[1].cases[1].ok, false);
});

test("empty tap still produces valid xml", () => {
  const xml = tapToJunit("TAP version 13\n");
  assert.match(xml, /tests="0" failures="0"/);
});

test("cassette junit reads tap from stdin", () => {
  const xml = execFileSync("node", ["bin/cassette.js", "junit"], {
    input: PASS,
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  assert.match(xml, /<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.match(xml, /tests="2" failures="0"/);
});

test("cassette junit --out writes a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "junit-"));
  execFileSync("node", ["bin/cassette.js", "junit", "--out", join(dir, "r.xml")], {
    input: FAIL,
    cwd: new URL("..", import.meta.url),
    encoding: "utf8",
  });
  const xml = readFileSync(join(dir, "r.xml"), "utf8");
  assert.match(xml, /failures="1"/);
});
