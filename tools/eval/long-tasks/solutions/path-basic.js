function joinPath(...parts) {
  const joined = parts
    .filter((part) => part !== undefined && part !== null && String(part) !== '')
    .map(String)
    .join('/');
  const absolute = joined.startsWith('/');
  const stack = [];
  for (const segment of joined.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') {
      const last = stack[stack.length - 1];
      if (stack.length > 0 && last !== '..') stack.pop();
      else if (!absolute) stack.push('..');
      continue;
    }
    stack.push(segment);
  }
  return (absolute ? '/' : '') + stack.join('/');
}

function basenameNoExt(path) {
  const base = String(path).split(/[\\/]/).filter(Boolean).pop() ?? '';
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

function isAbsolutePath(path) {
  const text = String(path);
  return /^\//.test(text) || /^[A-Za-z]:[\\/]/.test(text) || /^\\\\/.test(text);
}

module.exports = { joinPath, basenameNoExt, isAbsolutePath };
