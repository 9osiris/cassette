// parse "512", "512b", "4kb", "2mb", "1gb" into bytes. plain number means bytes.
export function parseSize(text) {
  const m = /^\s*(\d+(?:\.\d+)?)\s*(b|kb|mb|gb)?\s*$/i.exec(text || "");
  if (!m) throw new Error('bad size "' + text + '", try 512b, 64kb, 2mb');
  const n = Number(m[1]);
  const mult = { b: 1, kb: 1024, mb: 1024 ** 2, gb: 1024 ** 3 }[
    (m[2] || "b").toLowerCase()
  ];
  return Math.floor(n * mult);
}
