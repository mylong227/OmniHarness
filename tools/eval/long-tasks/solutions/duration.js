function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) throw new Error('invalid duration');
  if (ms === 0) return '0s';
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  const parts = [];
  if (hours > 0) parts.push(`${hours}h`);
  if (minutes > 0) parts.push(`${minutes}m`);
  if (seconds > 0) parts.push(`${seconds}s`);
  return parts.join(' ');
}

function parseDuration(text) {
  const raw = String(text).trim();
  if (!/^(?:\d+[hms])+$/.test(raw)) throw new Error('invalid duration: ' + raw);
  let ms = 0;
  for (const match of raw.matchAll(/(\d+)([hms])/g)) {
    const amount = Number(match[1]);
    const unit = match[2];
    ms += amount * (unit === 'h' ? 3_600_000 : unit === 'm' ? 60_000 : 1_000);
  }
  return ms;
}

function isValidDuration(text) {
  return /^(?:\d+[hms])+$/.test(String(text).trim());
}

module.exports = { formatDuration, parseDuration, isValidDuration };
