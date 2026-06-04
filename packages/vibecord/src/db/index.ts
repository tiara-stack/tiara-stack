import { drizzle } from "drizzle-orm/better-sqlite3";
import Database from "better-sqlite3";
import * as schema from "./schema";

export type DatabaseInstance = ReturnType<typeof drizzle>;

let dbInstance: DatabaseInstance | null = null;

export function getDb(): DatabaseInstance {
  if (!dbInstance) {
    const dbPath = schema.getDbPath();
    const sqlite = new Database(dbPath);
    dbInstance = drizzle(sqlite, { schema });
  }
  return dbInstance;
}

export { schema };
