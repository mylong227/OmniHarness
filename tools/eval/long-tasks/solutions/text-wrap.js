function wrapText(text, width) {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [];
  const lines = [];
  let current = '';
  for (const word of words) {
    if (current === '') current = word;
    else if (current.length + 1 + word.length <= width) current += ' ' + word;
    else {
      lines.push(current);
      current = word;
    }
  }
  if (current !== '') lines.push(current);
  return lines;
}

function truncateMiddle(text, max) {
  if (text.length <= max) return text;
  if (max <= 1) return '…';
  const keep = max - 1;
  const left = Math.ceil(keep / 2);
  const right = keep - left;
  return text.slice(0, left) + '…' + text.slice(text.length - right);
}

function countWords(text) {
  return text.trim() === '' ? 0 : text.trim().split(/\s+/).length;
}

module.exports = { wrapText, truncateMiddle, countWords };
