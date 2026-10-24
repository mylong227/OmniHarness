function isLeapYear(year) {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function daysInMonth(year, month) {
  const table = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return table[month - 1] ?? 0;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.floor(Number(ms) / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const parts = [];
  if (hours > 0) parts.push(hours + 'h');
  if (minutes > 0) parts.push(minutes + 'm');
  if (seconds > 0 || parts.length === 0) parts.push(seconds + 's');
  return parts.join(' ');
}

module.exports = { isLeapYear, daysInMonth, formatDuration };
