function toCamel(s) {
  const parts = String(s)
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  return parts
    .map((part, index) =>
      index === 0 ? part.toLowerCase() : part[0].toUpperCase() + part.slice(1).toLowerCase(),
    )
    .join('');
}

function truncate(s, n) {
  const text = String(s);
  if (n <= 0) return '';
  if (text.length <= n) return text;
  if (n === 1) return '…';
  return text.slice(0, n - 1) + '…';
}

function countWords(s) {
  const text = String(s).trim();
  return text === '' ? 0 : text.split(/\s+/).length;
}

module.exports = { toCamel, truncate, countWords };
