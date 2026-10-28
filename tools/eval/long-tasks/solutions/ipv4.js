function isValidIpv4(text) {
  if (typeof text !== 'string') return false;
  const parts = text.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^(0|[1-9]\d{0,2})$/.test(part) && Number(part) <= 255);
}

function ipToInt(text) {
  if (!isValidIpv4(text)) throw new Error('invalid ipv4: ' + String(text));
  return text.split('.').reduce((value, part) => value * 256 + Number(part), 0);
}

function intToIp(value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) {
    throw new Error('invalid ip integer');
  }
  const parts = [];
  let rest = value;
  for (let i = 0; i < 4; i += 1) {
    parts.unshift(rest % 256);
    rest = Math.floor(rest / 256);
  }
  return parts.join('.');
}

module.exports = { isValidIpv4, ipToInt, intToIp };
