import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { database, type Database, type Db } from "../src/db.js";
import type { Config } from "../src/config.js";
export const testConfig: Config = {
  databaseUrl: "test",
  activeKey: "v1",
  keys: { v1: randomBytes(32).toString("base64") },
  tokenPepper: randomBytes(32).toString("hex"),
  metricsToken: randomBytes(32).toString("hex"),
  port: 3000,
  production: false,
};
export async function testDatabase(): Promise<Database> {
  if (process.env.TEST_DATABASE_URL) {
    const db = database(process.env.TEST_DATABASE_URL);
    // Test URL must point to a disposable database; refuse accidental non-test targets.
    if (!new URL(process.env.TEST_DATABASE_URL).pathname.endsWith("_test"))
      throw new Error("TEST_DATABASE_URL database name must end in _test");
    await db.query("DROP SCHEMA public CASCADE");
    await db.query("CREATE SCHEMA public");
    await db.query(await readFile("migrations/001_initial.sql", "utf8"));
    return db;
  }
  const pg = new PGlite();
  await pg.exec(await readFile("migrations/001_initial.sql", "utf8"));
  const adapter = (client: any): Db => ({
    async query(sql, params) {
      const r = await client.query(sql, params);
      return {
        rows: r.rows,
        rowCount: /^\s*SELECT\b/i.test(sql)
          ? r.rows.length
          : (r.affectedRows ?? r.rows.length),
      };
    },
  });
  return {
    ...adapter(pg),
    transaction: (fn) => pg.transaction((tx) => fn(adapter(tx))),
    close: () => pg.close(),
  };
}
