import type { Database } from "./db.js";
export const retryDelay = (attempt: number, random = Math.random) =>
  Math.min(300000, 1000 * 2 ** attempt) * (0.5 + random() * 0.5);
export async function processOne(
  db: Database,
): Promise<"idle" | "processed" | "retry" | "dead"> {
  return db.transaction(async (tx) => {
    const job = (
      await tx.query(
        "SELECT * FROM outbox WHERE processed_at IS NULL AND dead_at IS NULL AND available_at<=now() ORDER BY available_at FOR UPDATE SKIP LOCKED LIMIT 1",
      )
    ).rows[0];
    if (!job) return "idle";
    await tx.query("SAVEPOINT job");
    try {
      if (job.topic !== "consultation.changed")
        throw new Error("Unsupported event");
      const source = (
        await tx.query(
          "SELECT (created_at AT TIME ZONE 'UTC')::date::text AS day FROM consultations WHERE id=$1",
          [job.aggregate_id],
        )
      ).rows[0];
      if (!source) throw new Error("Missing aggregate");
      await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `analytics:${source.day}`,
      ]);
      await tx.query(
        `INSERT INTO daily_analytics(day,booked,completed,cancelled) SELECT $1::date,count(*) FILTER(WHERE status IN ('booked','in_progress')),count(*) FILTER(WHERE status='completed'),count(*) FILTER(WHERE status='cancelled') FROM consultations WHERE created_at >= $1::date::timestamp AT TIME ZONE 'UTC' AND created_at < ($1::date+1)::timestamp AT TIME ZONE 'UTC' ON CONFLICT(day) DO UPDATE SET booked=EXCLUDED.booked,completed=EXCLUDED.completed,cancelled=EXCLUDED.cancelled,refreshed_at=now()`,
        [source.day],
      );
      await tx.query(
        "INSERT INTO job_receipts(event_id) VALUES($1) ON CONFLICT DO NOTHING",
        [job.id],
      );
      await tx.query("UPDATE outbox SET processed_at=now() WHERE id=$1", [
        job.id,
      ]);
      return "processed";
    } catch {
      await tx.query("ROLLBACK TO SAVEPOINT job");
      const attempt = job.attempts + 1;
      await tx.query(
        "UPDATE outbox SET attempts=$2,available_at=now()+$3 * interval '1 millisecond',dead_at=CASE WHEN $2>=8 THEN now() ELSE NULL END WHERE id=$1",
        [job.id, attempt, retryDelay(attempt)],
      );
      return attempt >= 8 ? "dead" : "retry";
    }
  });
}
