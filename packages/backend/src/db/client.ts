import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import { schema } from "./schema";

export const db = drizzle(postgres(process.env.DATABASE_URL!), { schema });
export type DB = typeof db;
