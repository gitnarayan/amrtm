import { describe, it, expect } from "vitest";
import {
  cipher,
  canonical,
  totp,
  verifyTotp,
  passwordHash,
  passwordVerify,
  tokenHash,
} from "../src/security.js";
import { retryDelay } from "../src/worker.js";
import { testConfig } from "./helpers.js";
import { config } from "../src/config.js";
describe("security primitives", () => {
  it("rejects a production TLS-mode substring bypass", () => {
    const env = {
      DATA_KEYS: JSON.stringify(testConfig.keys),
      TOKEN_PEPPER: testConfig.tokenPepper,
      METRICS_TOKEN: testConfig.metricsToken,
      NODE_ENV: "production",
      DATABASE_URL:
        "postgres://localhost/db?ignored=sslmode=verify-full&sslmode=disable",
    };
    expect(() => config(env)).toThrow("verify-full");
    expect(
      config({
        ...env,
        DATABASE_URL: "postgres://localhost/db?sslmode=verify-full",
      }).production,
    ).toBe(true);
  });
  it("binds authenticated encryption to a record and detects tampering", () => {
    const c = cipher(testConfig);
    const encrypted = c.encrypt({ notes: "private" }, "record:1");
    expect(c.decrypt(encrypted, "record:1")).toEqual({ notes: "private" });
    expect(() => c.decrypt(encrypted, "record:2")).toThrow();
    const parts = encrypted.split(".");
    parts[3] = Buffer.from("tampered").toString("base64");
    expect(() => c.decrypt(parts.join("."), "record:1")).toThrow();
  });
  it("supports decrypting with old keys after active-key rotation", () => {
    const old = cipher(testConfig).encrypt("data", "x");
    const rotated = cipher({
      ...testConfig,
      keys: { ...testConfig.keys, v2: Buffer.alloc(32, 2).toString("base64") },
      activeKey: "v2",
    });
    expect(rotated.decrypt(old, "x")).toBe("data");
    expect(rotated.encrypt("new", "x")).toMatch(/^v2\./);
  });
  it("matches RFC 6238 SHA1 vector and rejects used time steps", () => {
    const secret = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
    expect(totp(secret, 1)).toBe("287082");
    expect(verifyTotp(secret, "287082", -1, 59000)).toBe(1);
    expect(() => verifyTotp(secret, "287082", 1, 59000)).toThrow("invalid_mfa");
  });
  it("hashes passwords with distinct salts and verifies them", async () => {
    const p = "long test password!";
    const stored = await passwordHash(p);
    expect(await passwordVerify(p, stored)).toBe(true);
    expect(await passwordVerify("wrong", stored)).toBe(false);
  }, 10000);
  it("canonicalizes object order but preserves array order", () => {
    expect(canonical({ b: 2, a: 1 })).toBe(canonical({ a: 1, b: 2 }));
    expect(canonical([1, 2])).not.toBe(canonical([2, 1]));
  });
  it("uses keyed token hashes and bounded jitter", () => {
    expect(tokenHash("token", "a")).not.toBe(tokenHash("token", "b"));
    expect(retryDelay(1, () => 0)).toBe(1000);
    expect(retryDelay(100, () => 1)).toBe(300000);
  });
});
