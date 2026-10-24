function parseCsvLine(line) {
  const text = String(line);
  const out = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          current += '"';
          index += 1;
        } else {
          quoted = false;
        }
      } else {
        current += char;
      }
    } else if (char === '"') {
      quoted = true;
    } else if (char === ',') {
      out.push(current);
      current = '';
    } else {
      current += char;
    }
  }
  out.push(current);
  return out;
}

function escapeCsvField(value) {
  const text = value == null ? '' : String(value);
  return /[",\n\r]/.test(text) ? '"' + text.replace(/"/g, '""') + '"' : text;
}

function toCsvLine(fields) {
  return fields.map(escapeCsvField).join(',');
}

module.exports = { parseCsvLine, escapeCsvField, toCsvLine };
