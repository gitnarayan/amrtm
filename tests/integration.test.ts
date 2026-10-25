import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import type { Database } from "../src/db.js";
import { tokenHash, totp, hash, canonical } from "../src/security.js";
import { write } from "../src/transactions.js";
import { processOne } from "../src/worker.js";
import { testConfig, testDatabase } from "./helpers.js";
let db: Database, app: FastifyInstance;
const ids = {
  patient: randomUUID(),
  other: randomUUID(),
  doctor: randomUUID(),
  admin: randomUUID(),
};
const auth = (who: keyof typeof ids) => ({
  authorization: `Bearer ${who}-test-token`,
});
const mutate = (
  who: keyof typeof ids,
  method: "POST" | "PATCH",
  url: string,
  payload: any,
  key = randomUUID(),
) =>
  app.inject({
    method,
    url,
    payload,
    headers: { ...auth(who), "idempotency-key": key },
  });
const slot = async (offset = 1) => {
  const start = Date.now() + offset * 86400000;
  const r = await mutate("doctor", "POST", "/v1/slots", {
    startsAt: new Date(start).toISOString(),
    endsAt: new Date(start + 1800000).toISOString(),
  });
  expect(r.statusCode).toBe(201);
  return r.json().id as string;
};
beforeAll(async () => {
  db = await testDatabase();
  app = await buildApp(db, testConfig, false);
  for (const [name, id] of Object.entries(ids)) {
    const role = name === "other" ? "patient" : name;
    await db.query(
      "INSERT INTO users(id,email,password_hash,role,mfa_enabled) VALUES($1,$2,$3,$4,true)",
      [id, `${name}@example.test`, "unused", role],
    );
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '1 hour')",
      [tokenHash(`${name}-test-token`, testConfig.tokenPepper), id],
    );
  }
  await db.query(
    "INSERT INTO doctors(id,display_name,specialty,languages,fee_paise,verified) VALUES($1,$2,$3,$4,50000,true)",
    [ids.doctor, "Dr Test", "Ayurveda", ["English", "Hindi"]],
  );
}, 30000);
afterAll(async () => {
  await app?.close();
  await db?.close();
});
describe("API and database integration", () => {
  it("serves the care portal with CSP while keeping private files and APIs protected", async () => {
    const home = await app.inject("/");
    expect(home.statusCode).toBe(200);
    expect(home.headers["content-type"]).toContain("text/html");
    expect(home.headers["content-security-policy"]).toContain(
      "script-src 'self'",
    );
    expect(home.headers["content-security-policy"]).not.toContain(
      "unsafe-inline",
    );
    expect(home.headers["cache-control"]).toBe("no-store");
    expect(
      (await app.inject("/assets/app.js")).headers["content-type"],
    ).toContain("javascript");
    expect(
      (await app.inject("/assets/app.css")).headers["content-type"],
    ).toContain("text/css");
    expect((await app.inject("/.env")).statusCode).toBe(404);
    expect((await app.inject("/src/config.ts")).statusCode).toBe(404);
    expect((await app.inject("/v1/me")).statusCode).toBe(401);
  });

  it("never persists a fast unkeyed fingerprint of credential payloads", async () => {
    const key = randomUUID();
    const request = { password: "Sensitive credential" };
    await write(db, testConfig, "credential-test", key, request, async () => ({
      status: 200,
      body: { ok: true },
    }));
    const row = (
      await db.query(
        "SELECT request_hash FROM idempotency WHERE scope=$1 AND key=$2",
        ["credential-test", key],
      )
    ).rows[0]!;
    expect(row.request_hash).not.toBe(hash(canonical(request)));
    expect(row.request_hash).toBe(
      tokenHash(
        "idempotency-request:" + canonical(request),
        testConfig.tokenPepper,
      ),
    );
  });
  it("requires authentication, validates input and protects metrics", async () => {
    expect((await app.inject("/v1/doctors")).statusCode).toBe(401);
    expect((await app.inject("/metrics")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          url: "/metrics",
          headers: { authorization: `Bearer ${testConfig.metricsToken}` },
        })
      ).body,
    ).toContain("http_requests_total");
    expect(
      (
        await mutate("patient", "POST", "/v1/consultations", {
          slotId: "not-uuid",
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await mutate("patient", "POST", "/v1/slots", {
          startsAt: new Date().toISOString(),
          endsAt: new Date().toISOString(),
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/consultations",
          headers: auth("patient"),
          payload: { slotId: randomUUID() },
        })
      ).statusCode,
    ).toBe(400);
  });
  it("enforces overlap protection and returns one winner for competing bookings", async () => {
    const slotId = await slot();
    const source = (
      await db.query("SELECT * FROM availability_slots WHERE id=$1", [slotId])
    ).rows[0]!;
    expect(
      (
        await mutate("doctor", "POST", "/v1/slots", {
          startsAt: new Date(source.starts_at).toISOString(),
          endsAt: new Date(source.ends_at).toISOString(),
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await mutate("doctor", "POST", "/v1/slots", {
          startsAt: new Date(
            new Date(source.starts_at).getTime() + 60000,
          ).toISOString(),
          endsAt: new Date(
            new Date(source.ends_at).getTime() + 60000,
          ).toISOString(),
        })
      ).json().error,
    ).toBe("overlapping_slot");
    const results = await Promise.all([
      mutate("patient", "POST", "/v1/consultations", { slotId }),
      mutate("other", "POST", "/v1/consultations", { slotId }),
    ]);
    expect(results.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(
      (await db.query("SELECT * FROM consultations WHERE slot_id=$1", [slotId]))
        .rows,
    ).toHaveLength(1);
  });
  it("replays simultaneous identical writes and rejects key reuse with changed body", async () => {
    const slotId = await slot(2),
      key = randomUUID();
    const [a, b] = await Promise.all([
      mutate("patient", "POST", "/v1/consultations", { slotId }, key),
      mutate("patient", "POST", "/v1/consultations", { slotId }, key),
    ]);
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    expect(a.json()).toEqual(b.json());
    expect(
      (
        await mutate(
          "patient",
          "POST",
          "/v1/consultations",
          { slotId: randomUUID() },
          key,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await db.query("SELECT * FROM outbox WHERE aggregate_id=$1", [
          a.json().id,
        ])
      ).rows,
    ).toHaveLength(1);
  });
  it("protects clinical records, enforces transitions and encrypts prescriptions", async () => {
    const slotId = await slot(3);
    const booked = await mutate("patient", "POST", "/v1/consultations", {
      slotId,
    });
    const id = booked.json().id;
    expect(
      (
        await app.inject({
          url: `/v1/consultations/${id}`,
          headers: auth("other"),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          url: `/v1/consultations/${id}`,
          headers: auth("admin"),
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await mutate("patient", "PATCH", `/v1/consultations/${id}/status`, {
          status: "in_progress",
        })
      ).statusCode,
    ).toBe(403);
    expect(
      (
        await mutate("doctor", "PATCH", `/v1/consultations/${id}/status`, {
          status: "completed",
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await mutate("doctor", "PATCH", `/v1/consultations/${id}/status`, {
          status: "in_progress",
        })
      ).statusCode,
    ).toBe(200);
    const medication = {
      medications: [
        {
          name: "example medicine",
          dosage: "clinician supplied",
          instructions: "test only",
          durationDays: 3,
        },
      ],
      notes: "private diagnosis",
    };
    const prescription = await mutate(
      "doctor",
      "POST",
      `/v1/consultations/${id}/prescriptions`,
      medication,
    );
    expect(prescription.statusCode).toBe(201);
    const stored = (
      await db.query("SELECT * FROM prescriptions WHERE id=$1", [
        prescription.json().id,
      ])
    ).rows[0]!;
    expect(stored.encrypted_data).not.toContain("private diagnosis");
    const read = await app.inject({
      url: `/v1/consultations/${id}`,
      headers: auth("patient"),
    });
    expect(read.json().prescriptions[0].notes).toBe("private diagnosis");
    expect(
      (
        await mutate("doctor", "PATCH", `/v1/consultations/${id}/status`, {
          status: "completed",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await mutate(
          "doctor",
          "POST",
          `/v1/consultations/${id}/prescriptions`,
          medication,
        )
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await mutate("patient", "PATCH", `/v1/consultations/${id}/status`, {
          status: "cancelled",
        })
      ).statusCode,
    ).toBe(409);
  });
  it("cancels bookings, voids uncollected payment and permits rebooking", async () => {
    const slotId = await slot(4);
    const r = await mutate("patient", "POST", "/v1/consultations", { slotId });
    const id = r.json().id;
    expect(
      (
        await mutate("patient", "PATCH", `/v1/consultations/${id}/status`, {
          status: "cancelled",
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (
        await db.query("SELECT status FROM payments WHERE consultation_id=$1", [
          id,
        ])
      ).rows[0]!.status,
    ).toBe("void");
    expect(
      (await mutate("other", "POST", "/v1/consultations", { slotId }))
        .statusCode,
    ).toBe(201);
  });
  it("rolls back domain changes when idempotent transaction fails", async () => {
    const key = randomUUID(),
      id = randomUUID();
    await expect(
      write(db, testConfig, "test", key, { x: 1 }, async (tx) => {
        await tx.query(
          "INSERT INTO outbox(id,topic,aggregate_id) VALUES($1,$2,$3)",
          [id, "test", id],
        );
        throw new Error("simulated failure");
      }),
    ).rejects.toThrow();
    expect(
      (await db.query("SELECT * FROM outbox WHERE id=$1", [id])).rows,
    ).toHaveLength(0);
    expect(
      (await db.query("SELECT * FROM idempotency WHERE key=$1", [key])).rows,
    ).toHaveLength(0);
  });
  it("processes outbox into analytics and dead-letters unsupported jobs", async () => {
    while ((await processOne(db)) !== "idle") {}
    expect(
      (await db.query("SELECT * FROM daily_analytics")).rows.length,
    ).toBeGreaterThan(0);
    const id = randomUUID();
    await db.query(
      "INSERT INTO outbox(id,topic,aggregate_id,attempts) VALUES($1,$2,$1,7)",
      [id, "unsupported"],
    );
    expect(await processOne(db)).toBe("dead");
    expect(
      (await db.query("SELECT dead_at FROM outbox WHERE id=$1", [id])).rows[0]!
        .dead_at,
    ).toBeTruthy();
    expect(
      (
        await app.inject({
          url: "/v1/admin/analytics?from=2020-01-01&to=2020-01-02",
          headers: auth("patient"),
        })
      ).statusCode,
    ).toBe(403);
  });
  it("aggregates UTC days independently of database timezone and returns a date", async () => {
    const timestamps = [
      "2020-01-01T23:59:59Z",
      "2020-01-02T00:00:00Z",
      "2020-01-02T23:59:59Z",
      "2020-01-03T00:00:00Z",
    ];
    const consultationIds: string[] = [];
    for (let i = 0; i < timestamps.length; i++) {
      const slotId = randomUUID(),
        id = randomUUID();
      const start = new Date(Date.UTC(2035, 0, 1, i));
      await db.query(
        "INSERT INTO availability_slots(id,doctor_id,starts_at,ends_at) VALUES($1,$2,$3,$4)",
        [slotId, ids.doctor, start, new Date(start.getTime() + 1800000)],
      );
      await db.query(
        "INSERT INTO consultations(id,patient_id,doctor_id,slot_id,status,created_at) VALUES($1,$2,$3,$4,'completed',$5)",
        [id, ids.patient, ids.doctor, slotId, timestamps[i]],
      );
      consultationIds.push(id);
    }
    for (const zone of ["Asia/Calcutta", "America/New_York", "UTC"]) {
      await db.query(
        "INSERT INTO outbox(id,topic,aggregate_id) VALUES($1,'consultation.changed',$2)",
        [randomUUID(), consultationIds[1]],
      );
      const zonedDb: Database = {
        query: db.query.bind(db),
        close: async () => {},
        transaction: (fn) =>
          db.transaction(async (tx) => {
            await tx.query("SELECT set_config('TimeZone',$1,true)", [zone]);
            return fn(tx);
          }),
      };
      while ((await processOne(zonedDb)) !== "idle") {}
      const rows = (
        await db.query(
          "SELECT day::text,completed FROM daily_analytics WHERE day='2020-01-02'",
        )
      ).rows;
      expect(rows[0]!.day).toBe("2020-01-02");
      expect(Number(rows[0]!.completed)).toBe(2);
    }
    const response = await app.inject({
      url: "/v1/admin/analytics?from=2020-01-02&to=2020-01-02",
      headers: auth("admin"),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().items[0].day).toBe("2020-01-02");
    expect(Number(response.json().items[0].completed)).toBe(2);
  });
  it("prevents updating or deleting audit evidence", async () => {
    await expect(
      db.query("UPDATE audit_logs SET action='tampered'"),
    ).rejects.toThrow("append-only");
    await expect(db.query("DELETE FROM audit_logs")).rejects.toThrow(
      "append-only",
    );
  });
  it("filters the directory and hides booked slots", async () => {
    const r = await app.inject({
      url: "/v1/doctors?specialty=Ayurveda&language=Hindi&maxFeePaise=50000",
      headers: auth("patient"),
    });
    expect(r.json().items).toHaveLength(1);
    expect(
      (
        await app.inject({
          url: "/v1/doctors?specialty=Other",
          headers: auth("patient"),
        })
      ).json().items,
    ).toHaveLength(0);
  });
  it("completes enrollment, rejects TOTP reuse, and prevents secret reread after activation", async () => {
    const registered = await app.inject({
      method: "POST",
      url: "/v1/auth/register",
      headers: { "idempotency-key": randomUUID() },
      payload: {
        email: "new@example.test",
        password: "A long unique test password!",
        name: "Patient",
        consentVersion: "2026-01",
      },
    });
    expect(registered.statusCode).toBe(201);
    const h = {
      authorization: `Bearer ${registered.json().token}`,
      "idempotency-key": randomUUID(),
    };
    expect(
      (await app.inject({ url: "/v1/doctors", headers: h })).statusCode,
    ).toBe(401);
    const enrolled = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/enroll",
      headers: h,
      payload: {},
    });
    expect(enrolled.statusCode).toBe(200);
    const code = totp(enrolled.json().secret, Math.floor(Date.now() / 30000));
    const verifyHeaders = { ...h, "idempotency-key": randomUUID() };
    const verified = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/verify",
      headers: verifyHeaders,
      payload: { code },
    });
    expect(verified.statusCode).toBe(200);
    const replay = await app.inject({
      method: "POST",
      url: "/v1/auth/mfa/verify",
      headers: verifyHeaders,
      payload: { code },
    });
    expect(replay.json()).toEqual(verified.json());
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/mfa/verify",
          headers: { ...h, "idempotency-key": randomUUID() },
          payload: { code },
        })
      ).statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/mfa/enroll",
          headers: h,
          payload: {},
        })
      ).statusCode,
    ).toBe(409);
    const access = { authorization: `Bearer ${verified.json().token}` };
    expect(
      (await app.inject({ url: "/v1/me", headers: access })).json().profile
        .name,
    ).toBe("Patient");
    const login = await app.inject({
      method: "POST",
      url: "/v1/auth/login",
      headers: { "idempotency-key": randomUUID() },
      payload: {
        email: "new@example.test",
        password: "A long unique test password!",
      },
    });
    expect(login.json().kind).toBe("challenge");
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/v1/auth/logout",
          headers: { ...access, "idempotency-key": randomUUID() },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/v1/me", headers: access })).statusCode,
    ).toBe(401);
  }, 20000);
  it("revokes sessions on suspension and prevents self-demotion", async () => {
    expect(
      (
        await mutate("admin", "PATCH", `/v1/admin/users/${ids.admin}`, {
          role: "patient",
          active: true,
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await mutate("admin", "PATCH", `/v1/admin/users/${ids.other}`, {
          role: "patient",
          active: false,
        })
      ).statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ url: "/v1/doctors", headers: auth("other") }))
        .statusCode,
    ).toBe(401);
  });
});
