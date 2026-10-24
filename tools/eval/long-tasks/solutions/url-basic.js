function parseQuery(search) {
  const params = new URLSearchParams(String(search).replace(/^\?/, ''));
  const out = {};
  for (const [key, value] of params) out[key] = value;
  return out;
}

function buildQuery(params) {
  const search = new URLSearchParams();
  for (const key of Object.keys(params)) {
    const value = params[key];
    if (value === undefined) continue;
    search.append(key, String(value));
  }
  return search.toString();
}

function normalizePath(path) {
  const raw = String(path).replace(/\/{2,}/g, '/');
  if (raw === '/') return '/';
  return raw.replace(/\/+$/, '');
}

module.exports = { parseQuery, buildQuery, normalizePath };
