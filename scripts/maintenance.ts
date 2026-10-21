import { database } from "../src/db.js";
import { config } from "../src/config.js";
const db = database(config().databaseUrl);
try {
  for (const [table, predicate] of [
    ["sessions", "expires_at<now()"],
    ["rate_limits", "expires_at<now()"],
    ["idempotency", "created_at<now()-interval '7 days'"],
  ]) {
    // Identifiers are fixed internal constants, never user input.
    const result = await db.query(
      `DELETE FROM ${table} WHERE ctid IN (SELECT ctid FROM ${table} WHERE ${predicate} LIMIT 10000)`,
    );
    process.stdout.write(
      JSON.stringify({ table, deleted: result.rowCount }) + "\n",
    );
  }
} finally {
  await db.close();
}
