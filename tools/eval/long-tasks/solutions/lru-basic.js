function createLru(capacity) {
  const limit = Math.max(0, Math.floor(Number(capacity) || 0));
  const map = new Map();
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const value = map.get(key);
      map.delete(key);
      map.set(key, value);
      return value;
    },
    set(key, value) {
      if (limit <= 0) return;
      if (map.has(key)) map.delete(key);
      map.set(key, value);
      while (map.size > limit) map.delete(map.keys().next().value);
    },
    size() {
      return map.size;
    },
    keys() {
      return [...map.keys()];
    },
  };
}

module.exports = { createLru };
