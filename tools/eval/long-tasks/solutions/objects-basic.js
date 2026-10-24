function deepGet(obj, path, fallback) {
  const parts = String(path).split('.').filter(Boolean);
  let current = obj;
  for (const part of parts) {
    if (current === null || typeof current !== 'object' || !(part in current)) return fallback;
    current = current[part];
  }
  return current === undefined ? fallback : current;
}

function pick(obj, keys) {
  const out = {};
  for (const key of keys) {
    if (key in obj) out[key] = obj[key];
  }
  return out;
}

function omit(obj, keys) {
  const drop = new Set(keys);
  const out = {};
  for (const key of Object.keys(obj)) {
    if (!drop.has(key)) out[key] = obj[key];
  }
  return out;
}

module.exports = { deepGet, pick, omit };
