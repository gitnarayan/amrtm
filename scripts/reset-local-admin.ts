import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { database } from "../src/db.js";
import { passwordHash } from "../src/security.js";
import { audit } from "../src/transactions.js";

// Local operator recovery only. Password arrives over stdin, not command-line arguments.
const c = config();
const host = new URL(c.databaseUrl).hostname;
if (c.production || !["localhost", "127.0.0.1", "[::1]"].includes(host)) {
  throw new Error("This helper only supports a local development database.");
}
let input: { password?: string };
try {
  input = JSON.parse(readFileSync(0, "utf8").replace(/^\uFEFF/, ""));
} catch {
  throw new Error(
    "Run scripts/reset-local-admin.ps1 to supply a password privately.",
  );
}
const password = input.password;
if (
  typeof password !== "string" ||
  password.length < 15 ||
  password.length > 128
) {
  throw new Error("Choose a password between 15 and 128 characters.");
}
const hashed = await passwordHash(password);
const db = database(c.databaseUrl);
try {
  await db.transaction(async (tx) => {
    const user = (
      await tx.query(
        "SELECT id FROM users WHERE email=$1 AND role='admin' AND active FOR UPDATE",
        ["admin@example.com"],
      )
    ).rows[0];
    if (!user)
      throw new Error(
        "Active admin@example.com administrator not found; nothing changed.",
      );
    await tx.query("UPDATE users SET password_hash=$2 WHERE id=$1", [
      user.id,
      hashed,
    ]);
    await tx.query("DELETE FROM sessions WHERE user_id=$1", [user.id]);
    await audit(tx, null, "admin.local_password_reset", user.id, randomUUID());
  });
  console.log(
    "Password reset for admin@example.com. Existing sessions revoked. MFA settings unchanged.",
  );
} finally {
  await db.close();
}
