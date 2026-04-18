import type { FastifyBaseLogger } from "fastify";
import winston from "winston";

import { env } from "./env";

function safeStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  return JSON.stringify(value, (_key, val: unknown) => {
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    if (typeof val === "bigint") return val.toString();
    return val;
  });
}

const devFormat = winston.format.printf(
  ({ level, message, timestamp, stack, ...rest }) => {
    const meta = Object.keys(rest).length ? " " + safeStringify(rest) : "";
    const trace = stack ? "\n" + String(stack) : "";
    return `${String(timestamp)} ${level} ${String(message)}${meta}${trace}`;
  },
);

export const log = winston.createLogger({
  level: env.NODE_ENV === "production" ? "info" : "debug",
  format: winston.format.combine(
    winston.format.errors({ stack: true }),
    winston.format.timestamp(),
    env.NODE_ENV === "production"
      ? winston.format.json()
      : winston.format.combine(winston.format.colorize(), devFormat),
  ),
  transports: [new winston.transports.Console({ handleExceptions: true })],
  silent: env.NODE_ENV === "test",
});

function serializeReq(req: Record<string, unknown>) {
  return {
    method: req.method,
    url: req.url,
    id: req.id,
    remoteAddress: req.ip ?? req.remoteAddress,
  };
}

function serializeRes(res: Record<string, unknown>) {
  return { statusCode: res.statusCode };
}

function serializeMeta(meta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    if (k === "req" && v && typeof v === "object") {
      out.req = serializeReq(v as Record<string, unknown>);
    } else if (k === "res" && v && typeof v === "object") {
      out.res = serializeRes(v as Record<string, unknown>);
    } else if (k === "err" && v instanceof Error) {
      out.err = { type: v.name, message: v.message, stack: v.stack };
    } else {
      out[k] = v;
    }
  }
  return out;
}

function toMessage(args: unknown[]): {
  message: string;
  meta: Record<string, unknown>;
} {
  if (args.length === 0) return { message: "", meta: {} };
  const [first, second, ...rest] = args;
  if (first instanceof Error) {
    return {
      message: typeof second === "string" ? second : first.message,
      meta: { err: first },
    };
  }
  if (typeof first === "object" && first !== null) {
    return {
      message: typeof second === "string" ? second : "",
      meta: first as Record<string, unknown>,
    };
  }
  if (typeof first === "string") {
    const extras = [second, ...rest].filter((x) => x !== undefined);
    return {
      message: extras.length
        ? `${first} ${extras.map((x) => String(x)).join(" ")}`
        : first,
      meta: {},
    };
  }
  return { message: String(first), meta: {} };
}

function createFastifyLogger(
  bindings: Record<string, unknown> = {},
): FastifyBaseLogger {
  const emit =
    (level: "info" | "warn" | "error" | "debug") =>
    (...args: unknown[]) => {
      const { message, meta } = toMessage(args);
      log.log(level, message, serializeMeta({ ...bindings, ...meta }));
    };
  return {
    level: log.level,
    info: emit("info"),
    warn: emit("warn"),
    error: emit("error"),
    debug: emit("debug"),
    trace: emit("debug"),
    fatal: emit("error"),
    silent: () => {},
    child(childBindings: Record<string, unknown> = {}) {
      return createFastifyLogger({ ...bindings, ...childBindings });
    },
  };
}

export const fastifyLogger: FastifyBaseLogger = createFastifyLogger();
