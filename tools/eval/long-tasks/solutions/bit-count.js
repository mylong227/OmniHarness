function bitCount(value) {
  let n = value >>> 0;
  let count = 0;
  while (n !== 0) {
    n &= n - 1;
    count += 1;
  }
  return count;
}

function isPowerOfTwo(value) {
  return value > 0 && (value & (value - 1)) === 0;
}

function lowestBit(value) {
  return value === 0 ? 0 : value & -value;
}

module.exports = { bitCount, isPowerOfTwo, lowestBit };
