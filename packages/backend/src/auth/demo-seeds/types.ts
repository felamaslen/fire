import type { DB } from "@/db";

/** Callback the seed pipeline fires at each milestone. `progress` is 0..1 (exclusive of 1 — the final 1.0 event is emitted by the caller once the session is signed). */
export type DemoSeedProgress = (step: string, progress: number) => void;

/** Seed a demo schema with synthetic data. Receives a Drizzle db already bound to the session's schema, the "now" the seed should treat as today, and an `onProgress` callback for streaming progress updates to the client. */
export type DemoSeedFn = (ctx: {
  db: DB;
  today: Date;
  onProgress: DemoSeedProgress;
}) => Promise<void>;
