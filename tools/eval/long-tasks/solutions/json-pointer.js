function decode(token) {
  return token.replace(/~1/g, '/').replace(/~0/g, '~');
}

function encode(token) {
  return token.replace(/~/g, '~0').replace(/\//g, '~1');
}

function tokensOf(pointer) {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new Error('invalid json pointer: ' + pointer);
  return pointer.slice(1).split('/').map(decode);
}

function getPointer(object, pointer) {
  return tokensOf(pointer).reduce((current, key) => {
    if (current === null || current === undefined) return undefined;
    return current[key];
  }, object);
}

function setPointer(object, pointer, value) {
  const tokens = tokensOf(pointer);
  if (tokens.length === 0) throw new Error('setPointer 不支持根路径');
  const root = Array.isArray(object) ? [...object] : { ...object };
  let cursor = root;
  for (let i = 0; i < tokens.length - 1; i += 1) {
    const key = tokens[i];
    const next = cursor[key];
    cursor[key] = Array.isArray(next) ? [...next] : { ...next };
    cursor = cursor[key];
  }
  cursor[tokens[tokens.length - 1]] = value;
  return root;
}

function escapePointer(token) {
  return encode(String(token));
}

module.exports = { escapePointer, getPointer, setPointer };
