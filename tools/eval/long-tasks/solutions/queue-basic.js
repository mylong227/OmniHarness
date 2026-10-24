function createQueue(capacity) {
  const limit = Math.max(0, Math.floor(Number(capacity) || 0));
  const items = [];
  return {
    push(value) {
      if (items.length >= limit) return false;
      items.push(value);
      return true;
    },
    shift() {
      return items.length === 0 ? undefined : items.shift();
    },
    size() {
      return items.length;
    },
    isFull() {
      return items.length >= limit;
    },
  };
}

module.exports = { createQueue };
