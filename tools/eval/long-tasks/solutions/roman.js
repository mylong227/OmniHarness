const TABLE = [
  [1000, 'M'],
  [900, 'CM'],
  [500, 'D'],
  [400, 'CD'],
  [100, 'C'],
  [90, 'XC'],
  [50, 'L'],
  [40, 'XL'],
  [10, 'X'],
  [9, 'IX'],
  [5, 'V'],
  [4, 'IV'],
  [1, 'I'],
];

function toRoman(value) {
  if (!Number.isInteger(value) || value < 1 || value > 3999) {
    throw new Error('roman value out of range: ' + String(value));
  }
  let rest = value;
  let out = '';
  for (const [amount, symbol] of TABLE) {
    while (rest >= amount) {
      out += symbol;
      rest -= amount;
    }
  }
  return out;
}

function fromRoman(text) {
  if (!isRoman(text)) throw new Error('invalid roman: ' + String(text));
  let index = 0;
  let total = 0;
  for (const [amount, symbol] of TABLE) {
    while (text.startsWith(symbol, index)) {
      total += amount;
      index += symbol.length;
    }
  }
  return total;
}

function isRoman(text) {
  if (typeof text !== 'string' || text === '') return false;
  try {
    return toRoman(fromRomanUnchecked(text)) === text;
  } catch {
    return false;
  }
}

function fromRomanUnchecked(text) {
  let index = 0;
  let total = 0;
  for (const [amount, symbol] of TABLE) {
    while (text.startsWith(symbol, index)) {
      total += amount;
      index += symbol.length;
    }
  }
  if (index !== text.length) throw new Error('invalid roman');
  return total;
}

module.exports = { toRoman, fromRoman, isRoman };
