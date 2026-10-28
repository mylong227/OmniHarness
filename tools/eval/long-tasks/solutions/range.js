function range(start, end, step = 1) {
  if (step === 0) throw new Error('step must not be 0');
  const out = [];
  if (step > 0) {
    for (let value = start; value < end; value += step) out.push(value);
  } else {
    for (let value = start; value > end; value += step) out.push(value);
  }
  return out;
}

function sumRange(start, end) {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  return range(low, high).reduce((sum, value) => sum + value, 0);
}

function productRange(start, end) {
  const low = Math.min(start, end);
  const high = Math.max(start, end);
  return range(Math.max(1, low), high).reduce((product, value) => product * value, 1);
}

module.exports = { range, sumRange, productRange };
