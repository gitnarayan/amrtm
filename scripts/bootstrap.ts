import { randomUUID } from "node:crypto";
import { config } from "../src/config.js";
import { database } from "../src/db.js";
import { cipher, passwordHash } from "../src/security.js";
import { audit } from "../src/transactions.js";
const email = process.env.BOOTSTRAP_EMAIL?.toLowerCase(),
  password = process.env.BOOTSTRAP_PASSWORD;
if (!email || !password || password.length < 15)
  throw new Error(
    "Set BOOTSTRAP_EMAIL and BOOTSTRAP_PASSWORD (15+ characters)",
  );
const c = config(),
  db = database(c.databaseUrl);
try {
  await db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(1942027)");
    if ((await tx.query("SELECT id FROM users WHERE role='admin'")).rowCount)
      throw new Error("Admin already exists; use the authenticated admin API");
    const id = randomUUID();
    await tx.query(
      "INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,'admin')",
      [id, email, await passwordHash(password)],
    );
    await tx.query(
      "INSERT INTO profiles(user_id,encrypted_data,consent_version) VALUES($1,$2,$3)",
      [
        id,
        cipher(c).encrypt({ name: "Administrator" }, `profile:${id}`),
        "2026-01",
      ],
    );
    await audit(tx, null, "admin.bootstrap", id, "bootstrap");
    process.stdout.write(
      "Admin created; login and enroll MFA before access.\n",
    );
  });
} finally {
  await db.close();
}
