import { mkdir, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { buildApp } from "../src/app.js";
import { testDatabase, testConfig } from "../tests/helpers.js";
import { tokenHash, totp } from "../src/security.js";
import { processOne } from "../src/worker.js";
if (process.env.TEST_DATABASE_URL)
  throw new Error("Demo is in-memory only: unset TEST_DATABASE_URL");
const db = await testDatabase();
const app = await buildApp(db, testConfig, false);
const transcript: any[] = [];
const redact = (value: any): any =>
  Array.isArray(value)
    ? value.map(redact)
    : value && typeof value === "object"
      ? Object.fromEntries(
          Object.entries(value).map(([k, v]) => [
            k,
            ["token", "secret", "uri"].includes(k) ? "[REDACTED]" : redact(v),
          ]),
        )
      : value;
async function call(
  label: string,
  method: "GET" | "POST" | "PATCH",
  url: string,
  access?: string,
  body?: any,
  key = randomUUID(),
  expected = 200,
) {
  const res = await app.inject({
    method,
    url,
    headers: {
      ...(access ? { authorization: `Bearer ${access}` } : {}),
      ...(method !== "GET" ? { "idempotency-key": key } : {}),
    },
    ...(body === undefined ? {} : { payload: body }),
  });
  const result = res.json();
  if (res.statusCode !== expected)
    throw new Error(
      `${label}: expected ${expected}, got ${res.statusCode}: ${res.body}`,
    );
  const entry = {
    label,
    method,
    url,
    status: res.statusCode,
    response: redact(result),
  };
  transcript.push(entry);
  process.stdout.write(JSON.stringify(entry) + "\n");
  return result;
}
try {
  const doctor = randomUUID(),
    admin = randomUUID(),
    other = randomUUID();
  for (const [id, role, raw] of [
    [doctor, "doctor", "doctor-demo"],
    [admin, "admin", "admin-demo"],
    [other, "patient", "other-demo"],
  ]) {
    await db.query(
      "INSERT INTO users(id,email,password_hash,role,mfa_enabled) VALUES($1,$2,$3,$4,true)",
      [id, `${id}@example.test`, "fixture-not-a-login-password", role],
    );
    await db.query(
      "INSERT INTO sessions(token_hash,user_id,kind,expires_at) VALUES($1,$2,'access',now()+interval '1 hour')",
      [tokenHash(raw!, testConfig.tokenPepper), id],
    );
  }
  await db.query(
    "INSERT INTO doctors(id,display_name,specialty,languages,fee_paise,verified) VALUES($1,$2,$3,$4,50000,true)",
    [doctor, "Dr Synthetic", "Ayurveda", ["English"]],
  );
  const registered = await call(
    "Patient registration",
    "POST",
    "/v1/auth/register",
    undefined,
    {
      email: "demo@example.test",
      password: "Synthetic demo password only!",
      name: "Synthetic Patient",
      consentVersion: "2026-01",
    },
    randomUUID(),
    201,
  );
  await call(
    "Enrollment token cannot access clinical API",
    "GET",
    "/v1/doctors",
    registered.token,
    undefined,
    randomUUID(),
    401,
  );
  const enrolled = await call(
    "Enroll authenticator",
    "POST",
    "/v1/auth/mfa/enroll",
    registered.token,
    {},
  );
  const access = await call(
    "Verify MFA",
    "POST",
    "/v1/auth/mfa/verify",
    registered.token,
    { code: totp(enrolled.secret, Math.floor(Date.now() / 30000)) },
  );
  const slot = await call(
    "Doctor publishes availability",
    "POST",
    "/v1/slots",
    "doctor-demo",
    {
      startsAt: new Date(Date.now() + 86400000).toISOString(),
      endsAt: new Date(Date.now() + 88200000).toISOString(),
    },
    randomUUID(),
    201,
  );
  await call(
    "Search doctors",
    "GET",
    "/v1/doctors?specialty=Ayurveda",
    access.token,
  );
  const key = randomUUID();
  const booking = await call(
    "Book consultation",
    "POST",
    "/v1/consultations",
    access.token,
    { slotId: slot.id },
    key,
    201,
  );
  const replay = await call(
    "Retry returns identical booking",
    "POST",
    "/v1/consultations",
    access.token,
    { slotId: slot.id },
    key,
    201,
  );
  if (replay.id !== booking.id) throw new Error("Replay mismatch");
  await call(
    "Competing patient cannot double-book",
    "POST",
    "/v1/consultations",
    "other-demo",
    { slotId: slot.id },
    randomUUID(),
    409,
  );
  await call(
    "Other patient cannot read record",
    "GET",
    `/v1/consultations/${booking.id}`,
    "other-demo",
    undefined,
    randomUUID(),
    404,
  );
  await call(
    "Doctor starts consultation",
    "PATCH",
    `/v1/consultations/${booking.id}/status`,
    "doctor-demo",
    { status: "in_progress" },
  );
  await call(
    "Doctor issues prescription",
    "POST",
    `/v1/consultations/${booking.id}/prescriptions`,
    "doctor-demo",
    {
      medications: [
        {
          name: "Synthetic example only",
          dosage: "Not medical advice",
          instructions: "Demo fixture",
          durationDays: 1,
        },
      ],
    },
    randomUUID(),
    201,
  );
  await call(
    "Doctor completes consultation",
    "PATCH",
    `/v1/consultations/${booking.id}/status`,
    "doctor-demo",
    { status: "completed" },
  );
  await call(
    "Patient reads own prescription",
    "GET",
    `/v1/consultations/${booking.id}`,
    access.token,
  );
  let processed = 0;
  while ((await processOne(db)) !== "idle") processed++;
  transcript.push({ label: "Worker drains transactional outbox", processed });
  const today = new Date().toISOString().slice(0, 10);
  await call(
    "Admin analytics",
    "GET",
    `/v1/admin/analytics?from=${today}&to=${today}`,
    "admin-demo",
  );
  await call(
    "Admin audit metadata",
    "GET",
    "/v1/admin/audit?limit=10",
    "admin-demo",
  );
  await mkdir("demo-output", { recursive: true });
  await writeFile(
    "demo-output/transcript.json",
    JSON.stringify(
      {
        environment:
          "isolated PGlite; synthetic doctor/admin sessions are pre-provisioned fixtures",
        steps: transcript,
      },
      null,
      2,
    ),
  );
  process.stdout.write(
    "Demo complete. Redacted evidence: demo-output/transcript.json\n",
  );
} finally {
  await app.close();
  await db.close();
}
