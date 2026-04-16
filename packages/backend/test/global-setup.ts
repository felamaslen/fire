import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

const ADMIN_URL = "postgres://fire:fire@localhost:5433/postgres";
const TEMPLATE_DB = "fire_template";

export default async function globalSetup() {
  const admin = postgres(ADMIN_URL, { max: 1 });
  await admin.unsafe(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
  await admin.unsafe(`CREATE DATABASE "${TEMPLATE_DB}"`);
  await admin.end();

  const sql = postgres(`postgres://fire:fire@localhost:5433/${TEMPLATE_DB}`, {
    max: 1,
  });
  try {
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: "./src/db/migrations" });
  } finally {
    await sql.end();
  }
}
