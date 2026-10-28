function decode(text) {
  return decodeURIComponent(text.replace(/\+/g, ' '));
}

function parseQuery(query) {
  const out = {};
  const raw = String(query).replace(/^\?/, '').trim();
  if (raw === '') return out;
  for (const pair of raw.split('&')) {
    if (pair === '') continue;
    const at = pair.indexOf('=');
    const key = decode(at < 0 ? pair : pair.slice(0, at));
    const value = at < 0 ? '' : decode(pair.slice(at + 1));
    out[key] = value;
  }
  return out;
}

function buildQuery(params) {
  return Object.entries(params)
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
    .join('&');
}

function getQueryParam(query, key) {
  const parsed = parseQuery(query);
  return Object.hasOwn(parsed, key) ? parsed[key] : undefined;
}

module.exports = { parseQuery, buildQuery, getQueryParam };
