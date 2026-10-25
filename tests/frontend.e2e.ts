import { test, expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/app.js";
import { cipher, passwordHash, totp } from "../src/security.js";
import { testConfig, testDatabase } from "./helpers.js";
import type { Database } from "../src/db.js";
import { processOne } from "../src/worker.js";

let app: FastifyInstance, db: Database;
const password = "Synthetic-browser-test-123!";
const doctorId = randomUUID();
test.beforeAll(async () => {
  db = await testDatabase();
  const crypt = cipher(testConfig);
  for (const [id, email, role, name] of [
    [randomUUID(), "admin@browser.test", "admin", "Care Administrator"],
    [doctorId, "doctor@browser.test", "patient", "Dr Maya Shah"],
  ]) {
    await db.query(
      "INSERT INTO users(id,email,password_hash,role) VALUES($1,$2,$3,$4)",
      [id, email, await passwordHash(password), role],
    );
    await db.query(
      "INSERT INTO profiles(user_id,encrypted_data,consent_version) VALUES($1,$2,'2026-01')",
      [id, crypt.encrypt({ name }, "profile:" + id)],
    );
  }
  app = await buildApp(db, testConfig, false);
  await app.listen({ host: "127.0.0.1", port: 4317 });
});
test.afterAll(async () => {
  await app?.close();
  await db?.close();
});

async function verify(page: Page) {
  await expect(page.locator(".secret")).toBeVisible();
  const secret = (await page.locator(".secret").textContent())!;
  await page
    .getByLabel("Authenticator code")
    .fill(totp(secret, Math.floor(Date.now() / 30000)));
  await page.getByRole("button", { name: "Verify & continue" }).click();
  await expect(page.getByRole("button", { name: "Sign out" })).toBeVisible();
}
async function login(page: Page, email: string) {
  await page.goto("/");
  await page.getByLabel("Email address").fill(email);
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in securely" }).click();
  await verify(page);
}
test("patient, admin and doctor complete a real browser care workflow", async ({
  browser,
}) => {
  const patient = await browser.newPage();
  const admin = await browser.newPage();
  const doctor = await browser.newPage();
  const errors: string[] = [];
  for (const page of [patient, admin, doctor])
    page.on("pageerror", (e) => errors.push(e.message));
  await patient.goto("/");
  await patient.screenshot({
    path: "test-results/frontend-login.png",
    fullPage: true,
  });
  await patient
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await patient.getByLabel("Full name").fill("Aarav Sharma");
  await patient.getByLabel("Email address").fill("patient@browser.test");
  await patient.getByLabel("Password", { exact: true }).fill(password);
  await patient.getByRole("checkbox").check();
  await patient.getByRole("button", { name: "Create account →" }).click();
  await verify(patient);
  await expect(patient.getByText("No matching doctors")).toBeVisible();

  await login(admin, "admin@browser.test");
  await admin.getByRole("button", { name: "Manage access" }).click();
  const access = admin.locator('form[data-form="access"]');
  await access.getByLabel("User ID", { exact: true }).fill(doctorId);
  await access.locator('select[name="role"]').selectOption("doctor");
  admin.once("dialog", (dialog) => dialog.accept());
  await access.getByRole("button", { name: "Update access" }).click();
  await expect(admin.getByRole("status")).toContainText(
    "Account access updated",
  );
  const publish = admin.locator('form[data-form="doctor"]');
  await publish.getByLabel("Doctor user ID").fill(doctorId);
  await publish.getByLabel("Display name").fill("Dr Maya Shah");
  await publish.getByLabel("Specialty").fill("Ayurveda");
  await publish.getByLabel("Languages").fill("English, Hindi");
  await publish.getByLabel("Consultation fee").fill("500");
  await publish.getByRole("checkbox").check();
  await publish.getByRole("button", { name: "Verify & publish" }).click();
  await expect(admin.getByRole("status")).toContainText(
    "Verified doctor profile published",
  );

  await login(doctor, "doctor@browser.test");
  await doctor.getByRole("button", { name: "My availability" }).click();
  const start = new Date(Date.now() + 86400000),
    end = new Date(start.getTime() + 1800000);
  const local = (d: Date) =>
    new Date(d.getTime() - d.getTimezoneOffset() * 60000)
      .toISOString()
      .slice(0, 16);
  await doctor.getByLabel("Starts at").fill(local(start));
  await doctor.getByLabel("Ends at").fill(local(end));
  await doctor.getByRole("button", { name: "Publish slot" }).click();
  await expect(doctor.getByRole("status")).toContainText(
    "Availability published",
  );

  await patient
    .getByRole("button", { name: "Find doctors", exact: true })
    .click();
  await expect(
    patient.getByRole("heading", { name: "Dr Maya Shah" }),
  ).toBeVisible();
  await patient.screenshot({
    path: "test-results/frontend-directory.png",
    fullPage: true,
  });
  await patient.getByRole("button", { name: "View times" }).click();
  const bookingKeys: string[] = [];
  let dropResponse = true;
  await patient.route("**/v1/consultations", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    bookingKeys.push(route.request().headers()["idempotency-key"]!);
    const response = await route.fetch();
    if (dropResponse) {
      dropResponse = false;
      await route.abort("failed");
    } else await route.fulfill({ response });
  });
  patient.once("dialog", (dialog) => dialog.accept());
  await patient.getByRole("button", { name: "Book appointment" }).click();
  await expect(patient.getByRole("status")).toContainText(
    "Connection interrupted",
  );

  patient.once("dialog", (dialog) => dialog.accept());
  await patient.getByRole("button", { name: "Book appointment" }).click();
  await expect(patient.getByRole("status")).toContainText("Appointment booked");
  expect(bookingKeys).toHaveLength(2);
  expect(bookingKeys[0]).toBe(bookingKeys[1]);
  expect(
    (await db.query("SELECT count(*)::int AS total FROM consultations"))
      .rows[0]!.total,
  ).toBe(1);

  await doctor
    .getByRole("button", { name: "Consultations", exact: true })
    .click();
  await doctor.getByRole("button", { name: "Open", exact: true }).click();
  doctor.once("dialog", (dialog) => dialog.accept());
  await doctor.getByRole("button", { name: "Start consultation" }).click();
  await expect(
    doctor.getByRole("heading", { name: "Issue a prescription" }),
  ).toBeVisible();
  await doctor.getByLabel("Name", { exact: true }).fill("Synthetic test item");
  await doctor.getByLabel("Dosage", { exact: true }).fill("Demo only");
  await doctor
    .getByLabel("Instructions", { exact: true })
    .fill("Not for clinical use");
  await doctor.getByLabel("Duration (days)").fill("1");
  doctor.once("dialog", (dialog) => dialog.accept());
  await doctor
    .getByRole("button", { name: "Issue prescription", exact: true })
    .click();
  await expect(doctor.getByRole("status")).toContainText("Prescription issued");
  doctor.once("dialog", (dialog) => dialog.accept());
  await doctor.getByRole("button", { name: "Complete consultation" }).click();
  await expect(doctor.locator(".badge.completed")).toBeVisible();

  await patient.getByRole("button", { name: "My consultations" }).click();
  await patient.getByRole("button", { name: "Open", exact: true }).click();
  await expect(
    patient.getByText("Synthetic test item", { exact: true }),
  ).toBeVisible();
  await expect(
    patient.getByRole("button", { name: "Issue prescription", exact: true }),
  ).toHaveCount(0);
  await patient.setViewportSize({ width: 390, height: 844 });
  await patient.screenshot({
    path: "test-results/frontend-mobile.png",
    fullPage: true,
  });
  expect(
    await patient.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  while ((await processOne(db)) === "processed") {
    /* drain synthetic analytics events */
  }
  await admin.getByRole("button", { name: "Overview", exact: true }).click();
  await expect(
    admin.locator(".stat").filter({ hasText: "Completed" }).locator("strong"),
  ).toHaveText("1");
  await admin.getByRole("button", { name: "Audit trail" }).click();
  await expect(
    admin.getByRole("heading", { name: "Recent activity" }),
  ).toBeVisible();
  await patient.getByRole("button", { name: "Sign out" }).click();
  await expect(
    patient.getByRole("button", { name: "Sign in securely" }),
  ).toBeVisible();
  expect(
    await patient.evaluate(() => localStorage.length + sessionStorage.length),
  ).toBe(0);
  expect(errors).toEqual([]);
  await patient.close();
  await admin.close();
  await doctor.close();
});
