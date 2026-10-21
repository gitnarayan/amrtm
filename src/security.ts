import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  scrypt,
  timingSafeEqual,
} from "node:crypto";
import type { Config } from "./config.js";
export class HttpError extends Error {
  constructor(
    public statusCode: number,
    public code: string,
  ) {
    super(code);
  }
}
export function fail(status: number, code: string): never {
  throw new HttpError(status, code);
}
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const token = () => randomBytes(32).toString("base64url");
export const tokenHash = (s: string, pepper: string) =>
  createHmac("sha256", pepper).update(s).digest("hex");
export function canonical(v: any): string {
  if (Array.isArray(v)) return "[" + v.map(canonical).join(",") + "]";
  if (v && typeof v === "object")
    return (
      "{" +
      Object.keys(v)
        .sort()
        .map((k) => JSON.stringify(k) + ":" + canonical(v[k]))
        .join(",") +
      "}"
    );
  return JSON.stringify(v);
}
export function cipher(c: Config) {
  return {
    encrypt(value: any, aad: string) {
      const iv = randomBytes(12);
      const enc = createCipheriv(
        "aes-256-gcm",
        Buffer.from(c.keys[c.activeKey]!, "base64"),
        iv,
      );
      enc.setAAD(Buffer.from(aad));
      const data = Buffer.concat([
        enc.update(JSON.stringify(value)),
        enc.final(),
      ]);
      return [
        c.activeKey,
        iv.toString("base64"),
        enc.getAuthTag().toString("base64"),
        data.toString("base64"),
      ].join(".");
    },
    decrypt(value: string, aad: string) {
      const [kid, iv, tag, data] = value.split(".");
      const key = c.keys[kid!];
      if (!key) throw new Error("Unknown encryption key");
      const dec = createDecipheriv(
        "aes-256-gcm",
        Buffer.from(key, "base64"),
        Buffer.from(iv!, "base64"),
      );
      dec.setAAD(Buffer.from(aad));
      dec.setAuthTag(Buffer.from(tag!, "base64"));
      return JSON.parse(
        Buffer.concat([
          dec.update(Buffer.from(data!, "base64")),
          dec.final(),
        ]).toString(),
      );
    },
  };
}
let passwordWork = 0;
const derive = async (password: string, salt: string) => {
  if (passwordWork >= 2) fail(503, "authentication_busy");
  passwordWork++;
  try {
    return await new Promise<Buffer>((resolve, reject) =>
      scrypt(
        password,
        salt,
        64,
        { N: 131072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 },
        (err, key) => (err ? reject(err) : resolve(key)),
      ),
    );
  } finally {
    passwordWork--;
  }
};
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex");
  return salt + ":" + (await derive(password, salt)).toString("hex");
}
export async function passwordVerify(password: string, stored: string) {
  const [salt, key] = stored.split(":");
  const actual = await derive(password, salt!);
  const expected = Buffer.from(key!, "hex");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export function base32(buf: Buffer) {
  let bits = 0,
    value = 0,
    out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) out += alphabet[(value << (5 - bits)) & 31];
  return out;
}
export function totp(secret: string, step: number) {
  let bits = 0,
    value = 0;
  const bytes: number[] = [];
  for (const ch of secret) {
    const i = alphabet.indexOf(ch);
    if (i < 0) throw new Error("Invalid base32");
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(step));
  const mac = createHmac("sha1", Buffer.from(bytes)).update(count).digest();
  const offset = mac[19]! & 15;
  return ((mac.readUInt32BE(offset) & 0x7fffffff) % 1000000)
    .toString()
    .padStart(6, "0");
}
export function verifyTotp(
  secret: string,
  code: string,
  last: number,
  now = Date.now(),
) {
  const current = Math.floor(now / 30000);
  for (const step of [current - 1, current, current + 1])
    if (
      step > last &&
      timingSafeEqual(Buffer.from(totp(secret, step)), Buffer.from(code))
    )
      return step;
  return fail(401, "invalid_mfa");
}
