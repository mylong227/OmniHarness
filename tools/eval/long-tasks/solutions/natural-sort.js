function chunks(text) {
  return String(text).match(/(\d+|\D+)/g) ?? [];
}

function naturalCompare(left, right) {
  const a = chunks(left);
  const b = chunks(right);
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    const x = a[i];
    const y = b[i];
    const xNum = /^\d+$/.test(x);
    const yNum = /^\d+$/.test(y);
    if (xNum && yNum) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return a.length === b.length ? 0 : a.length < b.length ? -1 : 1;
}

function sortNatural(items) {
  return [...items].sort(naturalCompare);
}

function uniqueSorted(items) {
  return [...new Set(items)].sort(naturalCompare);
}

module.exports = { naturalCompare, sortNatural, uniqueSorted };
