function intersection(a, b) {
  const other = new Set(b);
  const out = [];
  for (const value of a) {
    if (other.has(value) && !out.includes(value)) out.push(value);
  }
  return out;
}

function difference(a, b) {
  const other = new Set(b);
  return a.filter((value, index) => !other.has(value) && a.indexOf(value) === index);
}

function union(a, b) {
  const out = [];
  for (const value of [...a, ...b]) {
    if (!out.includes(value)) out.push(value);
  }
  return out;
}

module.exports = { intersection, difference, union };
