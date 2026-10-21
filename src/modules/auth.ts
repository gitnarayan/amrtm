import { randomUUID, randomBytes } from "node:crypto";
import type { RouteContext } from "../http.js";
import { str, obj, email, password } from "../schema.js";
import {
  fail,
  passwordHash,
  passwordVerify,
  token,
  base32,
  verifyTotp,
} from "../security.js";
import { audit } from "../transactions.js";
export async function registerAuth(ctx: RouteContext) {
  const { route, db, crypt, session } = ctx;
  route({
    method: "POST",
    url: "/v1/auth/register",
    summary: "Register patient and obtain MFA enrollment token",
    public: true,
    body: obj({
      email,
      password,
      name: str(100),
      consentVersion: { const: "2026-01", type: "string" },
    }),
    handler: async (req, tx) => {
      const b = req.body;
      const id = randomUUID();
      await tx.query(
        "INSERT INTO users(id,email,password_hash) VALUES($1,$2,$3)",
        [id, b.email.toLowerCase(), await passwordHash(b.password)],
      );
      await tx.query(
        "INSERT INTO profiles(user_id,encrypted_data,consent_version) VALUES($1,$2,$3)",
        [
          id,
          crypt.encrypt({ name: b.name }, `profile:${id}`),
          b.consentVersion,
        ],
      );
      await audit(tx, id, "user.registered", id, req.id);
      return {
        status: 201,
        body: { userId: id, ...(await session(tx, id, "enroll")) },
      };
    },
  });
  // Constant-cost dummy credential for unknown accounts; generated once at startup.
  const dummy = await passwordHash(token());
  route({
    method: "POST",
    url: "/v1/auth/login",
    summary: "Validate password and obtain MFA challenge",
    public: true,
    body: obj({ email, password }),
    handler: async (req, tx) => {
      const normalized = req.body.email.toLowerCase();
      const user = (
        await tx.query("SELECT * FROM users WHERE email=$1", [normalized])
      ).rows[0];
      const valid = await passwordVerify(
        req.body.password,
        user?.password_hash ?? dummy,
      );
      if (!valid || !user?.active) fail(401, "invalid_credentials");
      await audit(tx, user.id, "auth.password_verified", user.id, req.id);
      return {
        status: 200,
        body: await session(
          tx,
          user.id,
          user.mfa_enabled ? "challenge" : "enroll",
        ),
      };
    },
  });
  route({
    method: "POST",
    url: "/v1/auth/mfa/enroll",
    summary: "Create TOTP secret; limited to initial enrollment",
    kinds: ["enroll"],
    body: obj({}),
    handler: async (req, tx, u) => {
      const user = (
        await tx.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [u!.id])
      ).rows[0]!;
      if (user.mfa_enabled) fail(409, "mfa_already_enabled");
      const secret = user.mfa_secret
        ? crypt.decrypt(user.mfa_secret, `mfa:${u!.id}`)
        : base32(randomBytes(20));
      await tx.query("UPDATE users SET mfa_secret=$2 WHERE id=$1", [
        u!.id,
        crypt.encrypt(secret, `mfa:${u!.id}`),
      ]);
      await audit(tx, u!.id, "auth.mfa_enrollment", u!.id, req.id);
      return {
        status: 200,
        body: {
          secret,
          uri: `otpauth://totp/Amrutam:${encodeURIComponent(user.email)}?secret=${secret}&issuer=Amrutam&algorithm=SHA1&digits=6&period=30`,
        },
      };
    },
  });
  route({
    method: "POST",
    url: "/v1/auth/mfa/verify",
    summary: "Verify one-time TOTP and issue 15 minute access token",
    kinds: ["enroll", "challenge"],
    body: obj({ code: { type: "string", pattern: "^[0-9]{6}$" } }),
    handler: async (req, tx, u) => {
      const user = (
        await tx.query("SELECT * FROM users WHERE id=$1 FOR UPDATE", [u!.id])
      ).rows[0]!;
      if (!user.mfa_secret) fail(409, "enroll_mfa_first");
      const step = verifyTotp(
        crypt.decrypt(user.mfa_secret, `mfa:${u!.id}`),
        req.body.code,
        Number(user.last_totp_step),
      );
      await tx.query(
        "UPDATE users SET mfa_enabled=true,last_totp_step=$2 WHERE id=$1",
        [u!.id, step],
      );
      // Challenge remains valid until expiry for exact idempotent replay, but TOTP counter prevents reuse with a fresh key.
      await audit(tx, u!.id, "auth.mfa_verified", u!.id, req.id);
      return { status: 200, body: await session(tx, u!.id, "access") };
    },
  });
  route({
    method: "POST",
    url: "/v1/auth/logout",
    summary: "Revoke all current sessions",
    body: obj({}),
    handler: async (req, tx, u) => {
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [u!.id]);
      await audit(tx, u!.id, "auth.logout", u!.id, req.id);
      return { status: 200, body: { revoked: true } };
    },
  });
  route({
    method: "GET",
    url: "/v1/me",
    summary: "Read own profile",
    handler: async (req, tx, u) => {
      return db.transaction(async (tr) => {
        const p = (
          await tr.query("SELECT * FROM profiles WHERE user_id=$1", [u!.id])
        ).rows[0];
        await audit(tr, u!.id, "profile.read", u!.id, req.id);
        return {
          status: 200,
          body: {
            id: u!.id,
            role: u!.role,
            profile: p
              ? crypt.decrypt(p.encrypted_data, `profile:${u!.id}`)
              : null,
          },
        };
      });
    },
  });
  route({
    method: "PATCH",
    url: "/v1/me",
    summary: "Update encrypted personal profile",
    body: obj(
      {
        name: str(100),
        phone: { type: "string", pattern: "^\\+?[0-9]{8,15}$" },
      },
      ["name"],
    ),
    handler: async (req, tx, u) => {
      await tx.query("UPDATE profiles SET encrypted_data=$2 WHERE user_id=$1", [
        u!.id,
        crypt.encrypt(req.body, `profile:${u!.id}`),
      ]);
      await audit(tx, u!.id, "profile.updated", u!.id, req.id);
      return { status: 200, body: { updated: true } };
    },
  });
}
