import { randomUUID } from "node:crypto";
import type { Database, Db } from "./db.js";
import type { Config } from "./config.js";
import { cipher, canonical, tokenHash, fail } from "./security.js";
export type Result = { status: number; body: any };
export async function audit(
  tx: Db,
  actor: string | null,
  action: string,
  resource: string | null,
  requestId: string,
) {
  await tx.query(
    "INSERT INTO audit_logs(id,actor_id,action,resource_id,request_id) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), actor, action, resource, requestId],
  );
}
export async function event(tx: Db, topic: string, id: string) {
  await tx.query("INSERT INTO outbox(id,topic,aggregate_id) VALUES($1,$2,$3)", [
    randomUUID(),
    topic,
    id,
  ]);
}
export async function write(
  db: Database,
  c: Config,
  scope: string,
  key: string | undefined,
  request: any,
  fn: (tx: Db) => Promise<Result>,
): Promise<Result> {
  if (!key || !/^[a-zA-Z0-9_-]{16,128}$/.test(key))
    fail(400, "idempotency_key_required");
  // Login bodies contain passwords: never persist a fast unkeyed password oracle.
  const digest = tokenHash(
    "idempotency-request:" + canonical(request),
    c.tokenPepper,
  );
  const aad = `idempotency:${scope}:${key}`;
  const crypt = cipher(c);
  return db.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
      aad,
    ]);
    const prior = (
      await tx.query("SELECT * FROM idempotency WHERE scope=$1 AND key=$2", [
        scope,
        key,
      ])
    ).rows[0];
    if (prior) {
      if (prior.request_hash !== digest) fail(409, "idempotency_conflict");
      return {
        status: prior.status_code,
        body: crypt.decrypt(prior.encrypted_response, aad),
      };
    }
    const result = await fn(tx);
    await tx.query(
      "INSERT INTO idempotency(scope,key,request_hash,encrypted_response,status_code) VALUES($1,$2,$3,$4,$5)",
      [scope, key, digest, crypt.encrypt(result.body, aad), result.status],
    );
    return result;
  });
}
export async function rateLimit(
  db: Database,
  bucket: string,
  max: number,
  seconds: number,
) {
  const row = (
    await db.query(
      `INSERT INTO rate_limits(bucket,hits,expires_at) VALUES($1,1,now()+$2 * interval '1 second') ON CONFLICT(bucket) DO UPDATE SET hits=CASE WHEN rate_limits.expires_at < now() THEN 1 ELSE rate_limits.hits+1 END, expires_at=CASE WHEN rate_limits.expires_at < now() THEN EXCLUDED.expires_at ELSE rate_limits.expires_at END RETURNING hits`,
      [bucket, seconds],
    )
  ).rows[0]!;
  if (row.hits > max) fail(429, "rate_limited");
}
