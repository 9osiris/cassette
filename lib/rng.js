// tiny seeded prng (mulberry32). replay timing uses this so --seed runs
// produce the same chunk delays every time, no deps.
export function seededRng(seed) {
  let s = (Number(seed) || 0) >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// one chunk's delay: base ms jittered between 0.5x and 1.5x.
// pass rng=null for a flat base delay.
export function nextChunkDelay(rng, baseMs) {
  if (!rng) return baseMs;
  return Math.round(baseMs * (0.5 + rng()));
}
