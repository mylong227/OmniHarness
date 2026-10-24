function parseSemver(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(version).trim());
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareSemver(a, b) {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null || right === null) throw new Error('invalid semver');
  for (const key of ['major', 'minor', 'patch']) {
    if (left[key] !== right[key]) return left[key] > right[key] ? 1 : -1;
  }
  return 0;
}

function satisfiesCaret(version, range) {
  const baseText = String(range).replace(/^\^/, '');
  const target = parseSemver(version);
  const base = parseSemver(baseText);
  if (target === null || base === null) return false;
  if (compareSemver(version, baseText) < 0) return false;
  if (base.major > 0) return target.major === base.major;
  if (base.minor > 0) return target.major === 0 && target.minor === base.minor;
  return compareSemver(version, baseText) === 0;
}

module.exports = { parseSemver, compareSemver, satisfiesCaret };
