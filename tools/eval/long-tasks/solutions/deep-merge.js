function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function mergeDeep(left, right) {
  const out = { ...left };
  for (const [key, value] of Object.entries(right)) {
    out[key] = isPlainObject(out[key]) && isPlainObject(value) ? mergeDeep(out[key], value) : value;
  }
  return out;
}

function getPath(object, path) {
  return path.split('.').reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    return current[key];
  }, object);
}

function setPath(object, path, value) {
  const keys = path.split('.');
  const clone = Array.isArray(object) ? [...object] : { ...object };
  let cursor = clone;
  for (let i = 0; i < keys.length - 1; i += 1) {
    const key = keys[i];
    const next = cursor[key];
    cursor[key] = Array.isArray(next) ? [...next] : { ...next };
    cursor = cursor[key];
  }
  cursor[keys[keys.length - 1]] = value;
  return clone;
}

module.exports = { mergeDeep, getPath, setPath };
