function createEmitter() {
  const handlers = new Map();
  const off = (event, handler) => {
    const list = handlers.get(event) ?? [];
    handlers.set(
      event,
      list.filter((item) => item !== handler),
    );
  };
  const on = (event, handler) => {
    const list = handlers.get(event) ?? [];
    list.push(handler);
    handlers.set(event, list);
    return () => off(event, handler);
  };
  const emit = (event, payload) => {
    for (const handler of [...(handlers.get(event) ?? [])]) handler(payload);
  };
  const once = (event, handler) => {
    const wrapper = (payload) => {
      off(event, wrapper);
      handler(payload);
    };
    return on(event, wrapper);
  };
  return { on, off, emit, once };
}

module.exports = { createEmitter };
