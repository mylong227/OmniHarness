const UNITS = ['B', 'KB', 'MB', 'GB', 'TB'];

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) throw new Error('invalid bytes: ' + String(bytes));
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}

function parseBytes(text) {
  const match = /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i.exec(String(text).trim());
  if (match === null) throw new Error('invalid bytes text: ' + String(text));
  const amount = Number(match[1]);
  const unit = UNITS.indexOf(match[2].toUpperCase());
  return Math.round(amount * Math.pow(1024, unit));
}

function isValidBytes(text) {
  return /^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)$/i.test(String(text).trim());
}

module.exports = { formatBytes, parseBytes, isValidBytes };
