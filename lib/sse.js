// minimal sse helpers, no deps. chunks are kept as raw text so replay
// reproduces exactly what the upstream sent.
export function parseSse(text) {
  const chunks = [];
  for (const part of text.split(/\r?\n\r?\n/)) {
    if (part.trim() !== "") chunks.push(part);
  }
  return chunks;
}

export function serializeSse(chunks) {
  if (!chunks.length) return "";
  return chunks.join("\n\n") + "\n\n";
}
