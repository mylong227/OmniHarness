function cToF(value) {
  return (value * 9) / 5 + 32;
}

function fToC(value) {
  return ((value - 32) * 5) / 9;
}

function convertTemperature(value, from, to) {
  const source = String(from).toUpperCase();
  const target = String(to).toUpperCase();
  if (!['C', 'F', 'K'].includes(source) || !['C', 'F', 'K'].includes(target)) {
    throw new Error('unsupported temperature unit');
  }
  const celsius = source === 'C' ? value : source === 'F' ? fToC(value) : value - 273.15;
  return target === 'C' ? celsius : target === 'F' ? cToF(celsius) : celsius + 273.15;
}

module.exports = { cToF, fToC, convertTemperature };
