import winston from "winston";

import { env } from "./env";

export const log = winston.createLogger({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  format: winston.format.combine(
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    env.NODE_ENV === "production"
      ? winston.format.json()
      : winston.format.printf(
          ({ level, message, timestamp, stack, ...rest }) => {
            const meta = Object.keys(rest).length
              ? " " + JSON.stringify(rest)
              : "";
            return `${String(timestamp)} ${level} ${String(message)}${meta}${stack ? "\n" + String(stack) : ""}`;
          },
        ),
  ),
  transports: [new winston.transports.Console({ handleExceptions: true })],
  silent: env.NODE_ENV === "test",
});
