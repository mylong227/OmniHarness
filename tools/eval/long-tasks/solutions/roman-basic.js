const VALUES = [
  ['M', 1000],
  ['CM', 900],
  ['D', 500],
  ['CD', 400],
  ['C', 100],
  ['XC', 90],
  ['L', 50],
  ['XL', 40],
  ['X', 10],
  ['IX', 9],
  ['V', 5],
  ['IV', 4],
  ['I', 1],
];

function toRoman(number) {
  let rest = Math.floor(Number(number));
  if (!Number.isFinite(rest) || rest < 1 || rest > 3999) throw new Error('out of range');
  let out = '';
  for (const [symbol, value] of VALUES) {
    while (rest >= value) {
      out += symbol;
      rest -= value;
    }
  }
  return out;
}

function fromRoman(text) {
  const input = String(text);
  let total = 0;
  let index = 0;
  for (const [symbol, value] of VALUES) {
    while (input.startsWith(symbol, index)) {
      total += value;
      index += symbol.length;
    }
  }
  return index === input.length ? total : NaN;
}

function isValidRoman(text) {
  const input = String(text);
  const value = fromRoman(input);
  return Number.isFinite(value) && value >= 1 && toRoman(value) === input;
}

module.exports = { toRoman, fromRoman, isValidRoman };
