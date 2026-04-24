import { randomUUID } from "node:crypto";

import { eq, lt } from "drizzle-orm";

import { defaultDb } from "@/db/client";
import { forgetDemoDb, getDemoDb } from "@/db/demo-db";
import { DemoSessions } from "@/db/schema/demo";
import { log } from "@/log";
import { removeSessionUploads } from "@/uploads";

import { dropDemoDatabase, provisionDemoDatabase } from "./demo-database";
import { DEMO_SEEDS } from "./demo-seeds";
import { DEMO_TOKEN_TTL_SECONDS } from "./token";

/** Progress callback for `createDemoSession`. `progress` is 0..1 exclusive of 1 — the final 1.0 event is fired by the caller once the auth token has been signed. */
export type DemoSessionProgress = (step: string, progress: number) => void;

/** Provision a fresh demo session: allocate a database name, `CREATE DATABASE … WITH TEMPLATE`, run the flavour's seed, register the row in `DemoSessions`. Returns the registry row. `onProgress` (if passed) receives milestone pings as the pipeline runs — consumed by the `demoProgress` subscription to drive the login progress bar. */
export async function createDemoSession(
  flavour: string,
  onProgress: DemoSessionProgress = () => {},
): Promise<{
  database: string;
  expiresAt: Date;
}> {
  const seed = DEMO_SEEDS[flavour];
  if (!seed) throw new Error(`Unknown demo flavour: ${flavour}`);
  const database = `demo_${randomUUID().replace(/-/gu, "").slice(0, 16)}`;
  const now = new Date();
  const expiresAt = new Date(now.getTime() + DEMO_TOKEN_TTL_SECONDS * 1000);

  onProgress("Provisioning database", 0.05);
  await provisionDemoDatabase(database);
  try {
    const sessionDb = getDemoDb(database);
    onProgress("Seeding demo data", 0.15);
    await seed({ db: sessionDb, today: now, onProgress });
    onProgress("Registering session", 0.97);
    await defaultDb
      .insert(DemoSessions)
      .values({ database, flavour, expiresAt });
  } catch (err) {
    forgetDemoDb(database);
    await dropDemoDatabase(database).catch(() => {});
    throw err;
  }
  return { database, expiresAt };
}

/** Drop the database + registry row for a demo session. Safe to call on an unknown database name (no-op). */
export async function dropDemoSession(database: string): Promise<void> {
  forgetDemoDb(database);
  await dropDemoDatabase(database).catch((err) => {
    log.warn("Failed to drop demo database", { database, err });
  });
  await removeSessionUploads(database).catch((err) => {
    log.warn("Failed to drop demo uploads", { database, err });
  });
  await defaultDb
    .delete(DemoSessions)
    .where(eq(DemoSessions.database, database));
}

/** Find and drop every demo session whose `expiresAt` has passed. Called on boot and on a 15-minute interval from the same cron set-up as `tasks/quote-cron`. */
export async function sweepExpiredDemoSessions(): Promise<void> {
  const expired = await defaultDb
    .select({ database: DemoSessions.database })
    .from(DemoSessions)
    .where(lt(DemoSessions.expiresAt, new Date()));
  for (const { database } of expired) {
    await dropDemoSession(database);
  }
  if (expired.length > 0) {
    log.info("Swept expired demo sessions", { count: expired.length });
  }
}
