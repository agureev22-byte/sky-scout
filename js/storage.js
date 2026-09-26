// Безопасная обёртка над localStorage: в приватном режиме или при переполнении
// хранилище может бросать исключения — приложение должно работать и без него.

const PREFIX = 'sky-scout:';
const memory = new Map();

function backend() {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null;
  } catch {
    return null;
  }
}

export const storage = {
  get(key, fallback = null) {
    try {
      const ls = backend();
      const raw = (ls ? ls.getItem(PREFIX + key) : null) ?? memory.get(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    const raw = JSON.stringify(value);
    memory.set(key, raw);
    try {
      const ls = backend();
      if (ls) ls.setItem(PREFIX + key, raw);
    } catch {
      /* хранилище недоступно — остаёмся на памяти */
    }
  },
  remove(key) {
    memory.delete(key);
    try {
      const ls = backend();
      if (ls) ls.removeItem(PREFIX + key);
    } catch {
      /* ничего */
    }
  },
};
