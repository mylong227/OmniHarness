function digitsOf(card) {
  const digits = String(card).replace(/[\s-]/g, '');
  if (!/^\d+$/.test(digits)) throw new Error('invalid card digits');
  return digits;
}

function checksumValid(digits) {
  let sum = 0;
  let double = false;
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let value = Number(digits[i]);
    if (double) {
      value *= 2;
      if (value > 9) value -= 9;
    }
    sum += value;
    double = !double;
  }
  return sum % 10 === 0;
}

function isValidCard(card) {
  try {
    const digits = digitsOf(card);
    return digits.length >= 2 && checksumValid(digits);
  } catch {
    return false;
  }
}

function generateCheckDigit(partial) {
  const digits = digitsOf(partial);
  for (let candidate = 0; candidate <= 9; candidate += 1) {
    if (checksumValid(digits + String(candidate))) return candidate;
  }
  throw new Error('unreachable');
}

function maskCard(card) {
  const digits = digitsOf(card);
  if (digits.length <= 4) return digits;
  return '*'.repeat(digits.length - 4) + digits.slice(-4);
}

module.exports = { isValidCard, generateCheckDigit, maskCard };
