// Tiny structured logger. Uses pino if installed, otherwise a console shim
// with the same (obj, msg) signature so call sites never change.

type Fields = Record<string, unknown>;

interface Logger {
  info(obj: Fields | string, msg?: string): void;
  warn(obj: Fields | string, msg?: string): void;
  error(obj: Fields | string, msg?: string): void;
  debug(obj: Fields | string, msg?: string): void;
}

function makeConsoleLogger(): Logger {
  const emit =
    (level: "info" | "warn" | "error" | "debug") =>
    (obj: Fields | string, msg?: string) => {
      const base = { level, pid: process.pid, time: new Date().toISOString() };
      if (typeof obj === "string") {
        console[level === "debug" ? "log" : level](JSON.stringify({ ...base, msg: obj }));
      } else {
        console[level === "debug" ? "log" : level](
          JSON.stringify({ ...base, ...obj, msg }),
        );
      }
    };
  return { info: emit("info"), warn: emit("warn"), error: emit("error"), debug: emit("debug") };
}

let logger: Logger;
try {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const pino = require("pino");
  logger = pino({ level: process.env.LOG_LEVEL ?? "info" });
} catch {
  logger = makeConsoleLogger();
}

export const log = logger;
