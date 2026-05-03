const PREFIX = "[istoria]";
const isDev = import.meta.env.DEV;

export const log = {
  warn: (...args: unknown[]) => console.warn(PREFIX, ...args),
  error: (...args: unknown[]) => console.error(PREFIX, ...args),
  info: (...args: unknown[]) => console.info(PREFIX, ...args),
  debug: (...args: unknown[]) => {
    if (isDev) console.debug(PREFIX, ...args);
  },
};
