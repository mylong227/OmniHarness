function multiply(left, right) {
  if (left.length === 0 || right.length === 0) throw new Error('empty matrix');
  if (left[0].length !== right.length) throw new Error('dimension mismatch');
  const rows = left.length;
  const cols = right[0].length;
  const inner = right.length;
  const out = Array.from({ length: rows }, () => Array.from({ length: cols }, () => 0));
  for (let i = 0; i < rows; i += 1) {
    for (let j = 0; j < cols; j += 1) {
      let sum = 0;
      for (let k = 0; k < inner; k += 1) sum += left[i][k] * right[k][j];
      out[i][j] = sum;
    }
  }
  return out;
}

function identity(size) {
  if (!Number.isInteger(size) || size <= 0) throw new Error('invalid size');
  return Array.from({ length: size }, (_row, i) =>
    Array.from({ length: size }, (_col, j) => (i === j ? 1 : 0)),
  );
}

function isSquare(matrix) {
  if (!Array.isArray(matrix) || matrix.length === 0) return false;
  return matrix.every((row) => Array.isArray(row) && row.length === matrix.length);
}

module.exports = { multiply, identity, isSquare };
