import { createMigrator } from "drizzle-pgkit-migrator";
import pgImport, { type Client } from "pg";

const PgImpl = pgImport.native ?? pgImport;

const ADMIN_URL = "postgres://fire:fire@localhost:5433/postgres";
const TEMPLATE_DB = "fire_template";

/**
 * Planning FY pre-seeded into the template DB so most planning tests can
 * attach payslips / bills / earnings / transactions to a known year without
 * each one paying the cost of `planningYearSet` (year row + 12 months). The
 * default clock in `test/setup.ts` is `2026-04-18`, so FY `2026` is "today"
 * and FY `2025` is the nearest past year — a natural fixture target. Tests
 * that exercise year creation directly (`graphql/planning/planning.test.ts`)
 * truncate `PlanningYears*` in their own `beforeEach` to start from empty.
 */
export const SEEDED_PLANNING_YEAR = 2025;

async function withAdmin<T>(
  url: string,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  const client = new PgImpl.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

export default async function globalSetup() {
  await withAdmin(ADMIN_URL, async (admin) => {
    await admin.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await admin.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
  });

  const templateUrl = `postgres://fire:fire@localhost:5433/${TEMPLATE_DB}`;
  const migrator = await createMigrator({
    databaseUrl: templateUrl,
    migrationsDir: "./src/db/migrations",
  });
  try {
    await migrator.up();
  } finally {
    await migrator.client.end();
  }

  await withAdmin(templateUrl, (client) =>
    seedPlanningYearFixture(client, SEEDED_PLANNING_YEAR),
  );
}

/**
 * Write one `PlanningYears` row + its 12 `PlanningMonths` (April → March in
 * UK FY terms) into the template DB. Kept as raw SQL — no app-schema
 * imports — so global setup doesn't pull in the full module graph.
 */
async function seedPlanningYearFixture(
  client: Client,
  year: number,
): Promise<void> {
  await client.query(`INSERT INTO "PlanningYears" ("year") VALUES ($1)`, [
    year,
  ]);
  // UK FY `year` runs April `year` → March `year + 1`. Each month anchors
  // on the 1st of the month, matching what `planningYearSet` writes.
  const rows = Array.from({ length: 12 }, (_, i) => {
    const monthIdx = (3 + i) % 12; // 0-based: April = 3
    const calendarYear = 3 + i < 12 ? year : year + 1;
    const date = new Date(Date.UTC(calendarYear, monthIdx, 1));
    return { year, date: date.toISOString().slice(0, 10) };
  });
  const placeholders = rows
    .map((_, i) => `($${i * 2 + 1}, $${i * 2 + 2})`)
    .join(", ");
  const params = rows.flatMap((r) => [r.year, r.date]);
  await client.query(
    `INSERT INTO "PlanningMonths" ("year", "date") VALUES ${placeholders}`,
    params,
  );
}
