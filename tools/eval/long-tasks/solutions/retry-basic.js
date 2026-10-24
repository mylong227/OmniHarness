async function retryAsync(fn, attempts, delayMs = 0) {
  const total = Math.max(1, Math.floor(Number(attempts) || 1));
  let lastError;
  for (let index = 0; index < total; index += 1) {
    try {
      return await fn(index);
    } catch (error) {
      lastError = error;
      if (index < total - 1 && delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }
  throw lastError;
}

module.exports = { retryAsync };
