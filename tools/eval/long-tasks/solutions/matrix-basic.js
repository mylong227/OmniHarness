function transpose(matrix) {
  if (matrix.length === 0) return [];
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function multiply(a, b) {
  const rows = a.length;
  const shared = b.length;
  const cols = b[0]?.length ?? 0;
  if ((a[0]?.length ?? 0) !== shared) throw new Error('dimension mismatch');
  const out = [];
  for (let row = 0; row < rows; row += 1) {
    const line = [];
    for (let column = 0; column < cols; column += 1) {
      let sum = 0;
      for (let k = 0; k < shared; k += 1) sum += a[row][k] * b[k][column];
      line.push(sum);
    }
    out.push(line);
  }
  return out;
}

function identity(n) {
  const size = Math.max(0, Math.floor(Number(n) || 0));
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, column) => (row === column ? 1 : 0)),
  );
}

module.exports = { transpose, multiply, identity };
