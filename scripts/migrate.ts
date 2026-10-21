import { readFile, readdir } from "node:fs/promises";
import { database } from "../src/db.js";
const db = database(
  process.env.MIGRATION_DATABASE_URL ?? process.env.DATABASE_URL ?? "",
);
try {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(1942026)");
    await tx.query(
      "CREATE TABLE IF NOT EXISTS schema_migrations(name text PRIMARY KEY,applied_at timestamptz NOT NULL DEFAULT now())",
    );
    for (const file of (await readdir("migrations"))
      .filter((f) => f.endsWith(".sql"))
      .sort()) {
      if (
        (
          await tx.query("SELECT name FROM schema_migrations WHERE name=$1", [
            file,
          ])
        ).rowCount
      )
        continue;
      await tx.query(await readFile(`migrations/${file}`, "utf8"));
      await tx.query("INSERT INTO schema_migrations(name) VALUES($1)", [file]);
      process.stdout.write(`Applied ${file}\n`);
    }
  });
} finally {
  await db.close();
}
