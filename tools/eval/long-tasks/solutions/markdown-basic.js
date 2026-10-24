function stripCodeFences(markdown) {
  return String(markdown).replace(/```[\s\S]*?```/g, '');
}

function extractHeadings(markdown) {
  const out = [];
  for (const line of stripCodeFences(markdown).split(/\r?\n/)) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (match !== null) out.push({ level: match[1].length, text: match[2] });
  }
  return out;
}

function buildToc(headings) {
  const levels = headings.map((heading) => heading.level);
  const min = levels.length === 0 ? 1 : Math.min(...levels);
  return headings
    .map((heading) => '  '.repeat(heading.level - min) + '- ' + heading.text)
    .join('\n');
}

module.exports = { stripCodeFences, extractHeadings, buildToc };
