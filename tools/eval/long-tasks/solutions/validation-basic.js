function isEmailLike(value) {
  return typeof value === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

function isHexColor(value) {
  return typeof value === 'string' && /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(value);
}

function isStrongPassword(value) {
  return (
    typeof value === 'string' &&
    value.length >= 8 &&
    /[A-Z]/.test(value) &&
    /[a-z]/.test(value) &&
    /\d/.test(value)
  );
}

module.exports = { isEmailLike, isHexColor, isStrongPassword };
