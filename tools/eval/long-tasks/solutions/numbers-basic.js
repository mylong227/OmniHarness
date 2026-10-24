function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function percent(part, total) {
  if (!total) return 0;
  return Math.round((part / total) * 1000) / 10;
}

function sumTo(n) {
  if (!Number.isFinite(n) || n < 1) return 0;
  const count = Math.floor(n);
  return (count * (count + 1)) / 2;
}

module.exports = { clamp, percent, sumTo };
