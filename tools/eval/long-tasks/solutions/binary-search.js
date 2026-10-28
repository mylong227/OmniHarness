function lowerBound(sorted, target) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sorted[mid] < target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function upperBound(sorted, target) {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (sorted[mid] <= target) low = mid + 1;
    else high = mid;
  }
  return low;
}

function searchRange(sorted, target) {
  const left = lowerBound(sorted, target);
  if (left >= sorted.length || sorted[left] !== target) return [-1, -1];
  return [left, upperBound(sorted, target) - 1];
}

module.exports = { lowerBound, upperBound, searchRange };
