import type { Logger } from "./protocol";

export function createConsoleLogger(prefix = "ui-host"): Logger {
  const format = (message: string) => `${prefix}: ${message}`;
  return {
    debug(message, extra) {
      if (extra === undefined) console.debug(format(message));
      else console.debug(format(message), extra);
    },
    info(message, extra) {
      if (extra === undefined) console.info(format(message));
      else console.info(format(message), extra);
    },
    warn(message, extra) {
      if (extra === undefined) console.warn(format(message));
      else console.warn(format(message), extra);
    },
    error(message, extra) {
      if (extra === undefined) console.error(format(message));
      else console.error(format(message), extra);
    },
  };
}

export function createSilentLogger(): Logger {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}
