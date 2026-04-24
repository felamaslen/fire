import { timingSafeEqual } from "node:crypto";

import { GraphQLError } from "graphql";
import type { Float, ID, Int } from "grats";

import {
  createJob,
  type DemoProgressEvent,
  emit as emitProgress,
  fail as failProgress,
  subscribe as subscribeProgress,
} from "@/auth/demo-progress";
import { DEMO_SEEDS } from "@/auth/demo-seeds";
import { createDemoSession, dropDemoSession } from "@/auth/demo-session";
import { signToken } from "@/auth/token";
import { env } from "@/env";
import { log } from "@/log";

import type { Context } from "./context";
import { VOID, Void } from "./void";

/**
 * Result of a successful `login` / `demoLogin`, and the shape of `me` for a valid token. The client just needs to know "am I logged in?" — `token` doubles as both credential and success signal. Session kind / flavour live inside the signed token itself and are re-derived server-side from the `Authorization` header on every request, so there's nothing for the client to track beyond this string.
 *
 * @gqlType
 */
export type AuthResult = {
  /** Signed token. Real tokens live 30 days; demo tokens live 6 hours. Store in `localStorage` and attach as `Authorization: Bearer <token>`. @gqlField */
  token: string;
  /** `true` when the session is a demo (synthetic data in a per-session database). Lets the UI hide or disable features that shouldn't run in demo mode — e.g. `payslipParse` which burns Gemini tokens. @gqlField */
  isDemo: boolean;
};

/**
 * A synthetic data flavour the user can pick to try the app without a real PIN. Returned by the `demos` query; passed back into `demoLogin` by `id` to provision a session seeded with that flavour's data.
 *
 * @gqlType
 */
export type Demo = {
  /** Stable identifier used as input to `demoLogin`. @gqlField */
  id: ID;
  /** Human-readable short name shown on the login screen. @gqlField */
  name: string;
  /** One-line blurb describing the financial profile the demo represents. @gqlField */
  description: string;
};

/** Source of truth for the demo list. Keys match `DEMO_SEEDS` so a new seed module only has to show up in one place to appear on the login screen. */
const DEMOS: readonly Demo[] = [
  {
    id: "COUPLE_TWO_KIDS",
    name: "Average couple, 2 kids",
    description: "Moderate salaries, mortgage, 10 years of history.",
  },
  {
    id: "STUDENT_SIDE_JOB",
    name: "Student with side job",
    description: "Student loan, small balances, ~2 years of history.",
  },
  {
    id: "STRUGGLING_SINGLE_PARENT",
    name: "Struggling single parent",
    description: "Personal loans, upside-down car loan, tight bills.",
  },
  {
    id: "EXECUTIVE_HIGH_BURN",
    name: "Executive, big earner, big burn",
    description: "Massive salary, massive expenses, fat pension.",
  },
  {
    id: "HENRY_MAXED_ACCOUNTS",
    name: "HENRY (high earner, not rich yet)",
    description: "Low expenses, maxed ISA + pension, fast trajectory.",
  },
];

/**
 * List available demo flavours for the login screen.
 *
 * @gqlQueryField
 * @gqlAnnotate noAuth
 */
export function demos(): Demo[] | null {
  return [...DEMOS];
}

/**
 * Return the current session's auth info, or `null` if the request is anonymous. Used by the web app on boot to decide whether to send the user to the login screen or straight to the dashboard.
 *
 * @gqlQueryField
 * @gqlAnnotate noAuth
 */
export function me(ctx: Context): AuthResult | null {
  if (ctx.session.kind === "anon") return null;
  if (ctx.session.kind === "real") {
    return { token: signToken({ kind: "real" }), isDemo: false };
  }
  return {
    token: signToken({
      kind: "demo",
      database: ctx.session.database,
      flavour: ctx.session.flavour,
    }),
    isDemo: true,
  };
}

/**
 * Exchange the 4-digit PIN (from the `AUTH_PIN` env var) for a 30-day real-session token. Rejects with `Invalid PIN` on mismatch; the comparison is constant-time.
 *
 * @gqlMutationField
 * @gqlAnnotate noAuth
 */
export function login(pin: Int): AuthResult {
  if (!constantTimeEqualInt(pin, env.AUTH_PIN)) {
    throw new GraphQLError("Invalid PIN", {
      extensions: { code: "UNAUTHENTICATED" },
    });
  }
  return { token: signToken({ kind: "real" }), isDemo: false };
}

/**
 * Handle returned by `demoLogin`. Kicks off demo provisioning in the background and hands the client a `jobId` to subscribe to via `demoProgress` for live progress + the final auth token.
 *
 * @gqlType
 */
export type DemoLoginStart = {
  /** Opaque job identifier. Pass to the `demoProgress` subscription to stream progress events; the final event carries the signed auth token. @gqlField */
  jobId: ID;
};

/**
 * One tick of progress while a demo session is being provisioned. Streamed by the `demoProgress` subscription. The terminal event has `progress === 1` and a non-null `token` — at that point the client stores the token and navigates into the app.
 *
 * @gqlType
 */
export type DemoProgress = {
  /** Human-readable label for the current milestone (e.g. `"Seeding assets & liabilities"`). Safe to show verbatim in the UI. @gqlField */
  step: string;
  /** Fraction complete, 0..1. The final event has `progress === 1`. @gqlField */
  progress: Float;
  /** Signed session token. Set only on the final (`progress === 1`) event — null on every intermediate tick. @gqlField */
  token: string | null;
};

/**
 * Start provisioning a fresh demo session: validates the flavour, kicks off database creation + seeding in the background, and returns immediately with a `jobId`. Subscribe to `demoProgress(jobId)` to stream progress events and receive the signed auth token on completion.
 *
 * @gqlMutationField
 * @gqlAnnotate noAuth
 */
export function demoLogin(id: ID): DemoLoginStart {
  if (!DEMO_SEEDS[id]) {
    throw new GraphQLError(`Unknown demo: ${id}`, {
      extensions: { code: "BAD_USER_INPUT" },
    });
  }
  const jobId = createJob();
  runDemoSeed(jobId, id);
  return { jobId };
}

function runDemoSeed(jobId: string, flavour: string): void {
  void (async () => {
    try {
      const { database } = await createDemoSession(
        flavour,
        (step, progress) => {
          emitProgress(jobId, { step, progress, token: null });
        },
      );
      const token = signToken({ kind: "demo", database, flavour });
      emitProgress(jobId, { step: "Ready", progress: 1, token });
    } catch (err) {
      log.error("Demo seed failed", { jobId, flavour, err });
      failProgress(jobId, err instanceof Error ? err : new Error(String(err)));
    }
  })();
}

/**
 * Live progress stream for a `demoLogin` job. Yields `DemoProgress` events as the seed pipeline runs; the final event has `progress === 1` and carries the signed session token. Terminates with an error if the seed fails.
 *
 * @gqlSubscriptionField
 * @gqlAnnotate noAuth
 */
export async function* demoProgress(jobId: ID): AsyncIterable<DemoProgress> {
  for await (const event of subscribeProgress(jobId)) {
    yield eventToGraphQL(event);
  }
}

function eventToGraphQL(event: DemoProgressEvent): DemoProgress {
  return { step: event.step, progress: event.progress, token: event.token };
}

/**
 * Invalidate the current session. For real sessions this is a no-op on the server (tokens are stateless — the client just discards it). For demo sessions this drops the per-session schema and its `DemoSessions` row, so a reconnect with the same token would fail.
 *
 * @gqlMutationField
 * @gqlAnnotate noAuth
 */
export async function logout(ctx: Context): Promise<Void> {
  if (ctx.session.kind === "demo") {
    await dropDemoSession(ctx.session.database);
  }
  return VOID;
}

function constantTimeEqualInt(a: number, b: number): boolean {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
