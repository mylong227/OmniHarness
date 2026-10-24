function chunk(items, size) {
  if (!Array.isArray(items) || !Number.isInteger(size) || size <= 0) return [];
  const out = [];
  for (let index = 0; index < items.length; index += size) {
    out.push(items.slice(index, index + size));
  }
  return out;
}

function uniqueBy(items, key) {
  const seen = new Set();
  const out = [];
  for (const item of items) {
    const value = item == null ? undefined : item[key];
    if (seen.has(value)) continue;
    seen.add(value);
    out.push(item);
  }
  return out;
}

function flattenDeep(items) {
  const out = [];
  for (const item of items) {
    if (Array.isArray(item)) out.push(...flattenDeep(item));
    else out.push(item);
  }
  return out;
}

module.exports = { chunk, uniqueBy, flattenDeep };
