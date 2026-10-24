function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function readingTime(text) {
  const trimmed = String(text).trim();
  if (trimmed === '') return 0;
  return Math.max(1, Math.ceil(trimmed.split(/\s+/).length / 200));
}

function wordFrequency(text) {
  const out = {};
  for (const word of String(text)
    .toLowerCase()
    .match(/[a-z0-9']+/g) ?? []) {
    out[word] = (out[word] ?? 0) + 1;
  }
  return out;
}

module.exports = { slugify, readingTime, wordFrequency };
