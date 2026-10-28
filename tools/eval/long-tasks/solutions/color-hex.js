function normalizeHex(input) {
  const raw = String(input).trim().replace(/^#/, '').toLowerCase();
  if (!/^[0-9a-f]{3}$|^[0-9a-f]{6}$/.test(raw)) return null;
  const full =
    raw.length === 3
      ? raw
          .split('')
          .map((c) => c + c)
          .join('')
      : raw;
  return '#' + full;
}

function hexToRgb(input) {
  const hex = normalizeHex(input);
  if (hex === null) throw new Error('invalid hex: ' + String(input));
  return {
    r: Number.parseInt(hex.slice(1, 3), 16),
    g: Number.parseInt(hex.slice(3, 5), 16),
    b: Number.parseInt(hex.slice(5, 7), 16),
  };
}

function rgbToHex(r, g, b) {
  for (const value of [r, g, b]) {
    if (!Number.isInteger(value) || value < 0 || value > 255) {
      throw new Error('rgb out of range');
    }
  }
  return '#' + [r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('');
}

module.exports = { normalizeHex, hexToRgb, rgbToHex };
