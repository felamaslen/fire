import type { DB } from "@/db";

/** Seed a demo schema with synthetic data. Receives a Drizzle db already bound to the session's schema and the "now" the seed should treat as today. */
export type DemoSeedFn = (ctx: { db: DB; today: Date }) => Promise<void>;
