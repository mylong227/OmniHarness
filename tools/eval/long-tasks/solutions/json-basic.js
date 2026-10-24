function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(String(text));
  } catch {
    return fallback;
  }
}

function flattenObject(obj, prefix = '') {
  const out = {};
  for (const [key, value] of Object.entries(obj ?? {})) {
    const path = prefix === '' ? key : prefix + '.' + key;
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      Object.assign(out, flattenObject(value, path));
    } else {
      out[path] = value;
    }
  }
  return out;
}

function countKeys(obj) {
  return Object.keys(flattenObject(obj)).length;
}

module.exports = { safeJsonParse, flattenObject, countKeys };
