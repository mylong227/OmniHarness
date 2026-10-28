function transpose(matrix) {
  if (matrix.length === 0) return [];
  return matrix[0].map((_, column) => matrix.map((row) => row[column]));
}

function rotate(matrix) {
  return transpose(matrix).map((row) => [...row].reverse());
}

function spiralOrder(matrix) {
  if (matrix.length === 0 || matrix[0].length === 0) return [];
  const out = [];
  let top = 0;
  let bottom = matrix.length - 1;
  let left = 0;
  let right = matrix[0].length - 1;
  while (top <= bottom && left <= right) {
    for (let c = left; c <= right; c += 1) out.push(matrix[top][c]);
    top += 1;
    for (let r = top; r <= bottom; r += 1) out.push(matrix[r][right]);
    right -= 1;
    if (top <= bottom) {
      for (let c = right; c >= left; c -= 1) out.push(matrix[bottom][c]);
      bottom -= 1;
    }
    if (left <= right) {
      for (let r = bottom; r >= top; r -= 1) out.push(matrix[r][left]);
      left += 1;
    }
  }
  return out;
}

module.exports = { rotate, transpose, spiralOrder };
