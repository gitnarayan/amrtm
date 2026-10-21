import { registerConsultations } from "./modules/consultations.js";
import { registerDirectory } from "./modules/directory.js";
import { registerAuth } from "./modules/auth.js";
import Fastify, { type FastifyRequest } from "fastify";
import helmet from "@fastify/helmet";
import swagger from "@fastify/swagger";
import { timingSafeEqual } from "node:crypto";
import {
  Registry,
  Histogram,
  Counter,
  Gauge,
  collectDefaultMetrics,
} from "prom-client";
import { trace, SpanStatusCode } from "@opentelemetry/api";
import type { Database, Db } from "./db.js";
import type { Config } from "./config.js";
import { cipher, token, tokenHash, fail, HttpError } from "./security.js";
import { audit, rateLimit, write, type Result } from "./transactions.js";

import { str, obj, page } from "./schema.js";
import { successSchema } from "./responses.js";
import type { Identity, Options } from "./http.js";
export async function buildApp(db: Database, c: Config, logging = true) {
  const app = Fastify({
    logger: logging
      ? {
          level: "info",
          redact: [
            "req.headers.authorization",
            "req.headers.cookie",
            'req.headers["idempotency-key"]',
          ],
        }
      : false,
    disableRequestLogging: true,
    bodyLimit: 32768,
    requestTimeout: 10000,
    trustProxy: c.trustedProxies ?? false,
    ajv: { customOptions: { removeAdditional: false } },
  });
  const crypt = cipher(c);
  const registry = new Registry();
  collectDefaultMetrics({ register: registry });
  const duration = new Histogram({
    name: "http_request_duration_seconds",
    help: "Request latency",
    labelNames: ["method", "route", "status"],
    buckets: [0.025, 0.05, 0.1, 0.2, 0.5, 1, 2, 5],
    registers: [registry],
  });
  const count = new Counter({
    name: "http_requests_total",
    help: "Requests",
    labelNames: ["method", "route", "status"],
    registers: [registry],
  });
  const pending = new Gauge({
    name: "outbox_pending",
    help: "Pending outbox events",
    registers: [registry],
  });
  const dead = new Gauge({
    name: "outbox_dead",
    help: "Dead-letter events requiring operator action",
    registers: [registry],
  });
  const lag = new Gauge({
    name: "outbox_oldest_age_seconds",
    help: "Age of oldest pending event",
    registers: [registry],
  });
  const starts = new WeakMap<FastifyRequest, number>();
  await app.register(helmet);
  await app.register(swagger, {
    openapi: {
      info: {
        title: "Amrutam Telemedicine API",
        version: "1.0.0",
        description:
          "All mutations require a unique Idempotency-Key (16–128 alphanumeric, underscore or hyphen). Reuse the same key and payload after an ambiguous failure. All users require TOTP MFA.",
      },
      components: {
        securitySchemes: { bearerAuth: { type: "http", scheme: "bearer" } },
      },
    },
  });
  app.addHook("onRequest", async (req) => {
    starts.set(req, performance.now());
    if (
      !["/health/live", "/health/ready", "/metrics"].includes(
        req.url.split("?")[0]!,
      )
    )
      await rateLimit(db, `ip:${tokenHash(req.ip, c.tokenPepper)}`, 300, 60);
  });
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.addHook("onResponse", async (req, reply) => {
    const labels = {
      method: req.method,
      route: req.routeOptions.url ?? "unmatched",
      status: String(reply.statusCode),
    };
    duration.observe(
      labels,
      (performance.now() - (starts.get(req) ?? performance.now())) / 1000,
    );
    count.inc(labels);
    app.log.info(
      {
        requestId: req.id,
        ...labels,
        traceId: trace.getActiveSpan()?.spanContext().traceId,
      },
      "request completed",
    );
  });
  app.setErrorHandler((err, req, reply) => {
    const error = err as any;
    const dbCode = String(error.code ?? "");
    const status = error.validation
      ? 400
      : (error.statusCode ??
        (["23505", "23P01"].includes(dbCode)
          ? 409
          : ["55P03", "40001", "40P01", "57014"].includes(dbCode)
            ? 503
            : 500));
    const code = error.validation
      ? "invalid_request"
      : error instanceof HttpError
        ? error.code
        : status === 409
          ? "conflict"
          : status === 503
            ? "temporarily_unavailable"
            : status < 500
              ? "invalid_request"
              : "internal_error";
    if (status >= 500) {
      app.log.error({ requestId: req.id, code: dbCode }, "request failed");
      trace.getActiveSpan()?.setStatus({ code: SpanStatusCode.ERROR });
    }
    if (status === 429 || status === 503) reply.header("Retry-After", "2");
    reply.code(status).send({ error: code, requestId: req.id });
  });
  async function identity(
    req: FastifyRequest,
    tx: Db = db,
    kinds = ["access"],
  ): Promise<Identity> {
    const raw = req.headers.authorization;
    if (!raw?.startsWith("Bearer ")) return fail(401, "unauthorized");
    const hashed = tokenHash(raw.slice(7), c.tokenPepper);
    const u = (
      await tx.query(
        `SELECT u.id,u.role,u.mfa_enabled,s.kind,s.token_hash FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active`,
        [hashed],
      )
    ).rows[0];
    if (!u || !kinds.includes(u.kind)) return fail(401, "unauthorized");
    if (kinds.length === 1 && kinds[0] === "enroll" && u.mfa_enabled)
      fail(409, "mfa_already_enabled");
    return u as Identity;
  }
  function role(u: Identity, ...roles: string[]) {
    if (!roles.includes(u.role)) fail(403, "forbidden");
  }
  async function session(tx: Db, user: string, kind: string) {
    const raw = token();
    await tx.query(
      "INSERT INTO sessions(token_hash,user_id,kind,expires_at) VALUES($1,$2,$3,now()+$4 * interval '1 second')",
      [
        tokenHash(raw, c.tokenPepper),
        user,
        kind,
        kind === "access" ? 900 : 600,
      ],
    );
    return { token: raw, kind, expiresIn: kind === "access" ? 900 : 600 };
  }
  function route(o: Options) {
    app.route({
      method: o.method,
      url: o.url,
      schema: {
        summary: o.summary,
        tags: [o.url.split("/")[2] ?? "system"],
        ...(o.public ? {} : { security: [{ bearerAuth: [] }] }),
        ...(o.body ? { body: o.body } : {}),
        ...(o.params ? { params: o.params } : {}),
        ...(o.querystring ? { querystring: o.querystring } : {}),
        ...(o.method === "GET"
          ? {}
          : {
              headers: {
                type: "object",
                required: ["idempotency-key"],
                properties: {
                  "idempotency-key": {
                    type: "string",
                    pattern: "^[a-zA-Z0-9_-]{16,128}$",
                  },
                },
              },
            }),
        response: {
          "2xx": successSchema(o.method, o.url),
          "4xx": obj({ error: str(), requestId: str() }),
          "5xx": obj({ error: str(), requestId: str() }),
        },
      },
      handler: async (req, reply) => {
        const u = o.public ? null : await identity(req, db, o.kinds);
        if (o.url === "/v1/auth/register")
          await rateLimit(
            db,
            `register:${tokenHash(req.ip, c.tokenPepper)}`,
            10,
            3600,
          );
        if (o.url === "/v1/auth/login")
          await rateLimit(
            db,
            `login:${tokenHash(String((req.body as any).email).toLowerCase(), c.tokenPepper)}`,
            10,
            900,
          );
        if (o.url === "/v1/auth/mfa/verify")
          await rateLimit(db, `mfa:${u!.id}`, 5, 300);
        let result: Result;
        if (o.method === "GET") result = await o.handler(req, db, u);
        else {
          const scope =
            u?.id ??
            `public:${o.url}:${tokenHash(String((req.body as any)?.email ?? req.ip).toLowerCase(), c.tokenPepper)}`;
          result = await write(
            db,
            c,
            scope,
            req.headers["idempotency-key"] as string,
            { method: o.method, path: req.url, body: req.body ?? {} },
            async (tx) =>
              o.handler(
                req,
                tx,
                o.public ? null : await identity(req, tx, o.kinds),
              ),
          );
        }
        reply.code(result.status).send(result.body);
      },
    });
  }
  app.get("/health/live", async () => ({ status: "ok" }));
  app.get("/health/ready", async () => {
    await db.query("SELECT 1");
    return { status: "ready" };
  });
  app.get("/metrics", async (req, reply) => {
    const provided = Buffer.from(req.headers.authorization ?? "");
    const expected = Buffer.from(`Bearer ${c.metricsToken}`);
    if (
      provided.length !== expected.length ||
      !timingSafeEqual(provided, expected)
    )
      fail(401, "unauthorized");
    const jobs = (
      await db.query(
        "SELECT count(*) FILTER(WHERE dead_at IS NULL) AS pending,count(*) FILTER(WHERE dead_at IS NOT NULL) AS dead,coalesce(extract(epoch FROM now()-min(created_at) FILTER(WHERE dead_at IS NULL)),0) AS lag FROM outbox WHERE processed_at IS NULL",
      )
    ).rows[0]!;
    pending.set(Number(jobs.pending));
    dead.set(Number(jobs.dead));
    lag.set(Number(jobs.lag));
    reply.type(registry.contentType);
    return registry.metrics();
  });
  await registerAuth({ route, db, c, crypt, role, session });
  await registerDirectory({ route, db, c, crypt, role, session });
  await registerConsultations({ route, db, c, crypt, role, session });
  route({
    method: "GET",
    url: "/v1/admin/analytics",
    summary: "Read asynchronous daily aggregates with freshness timestamp",
    querystring: obj({
      from: { type: "string", format: "date" },
      to: { type: "string", format: "date" },
    }),
    handler: async (req, tx, u) => {
      role(u!, "admin");
      if (
        new Date(req.query.to).getTime() - new Date(req.query.from).getTime() >
          366 * 86400000 ||
        req.query.from > req.query.to
      )
        fail(400, "invalid_date_range");
      return {
        status: 200,
        body: {
          items: (
            await tx.query(
              "SELECT * FROM daily_analytics WHERE day BETWEEN $1 AND $2 ORDER BY day",
              [req.query.from, req.query.to],
            )
          ).rows,
        },
      };
    },
  });
  route({
    method: "GET",
    url: "/v1/admin/audit",
    summary: "Read bounded audit metadata (no clinical payload)",
    querystring: obj(
      { after: { type: "string", format: "date-time" }, limit: page },
      [],
    ),
    handler: async (req, _tx, u) => {
      role(u!, "admin");
      return db.transaction(async (tx) => {
        const rows = (
          await tx.query(
            "SELECT * FROM audit_logs WHERE created_at>coalesce($1::timestamptz,now()-interval '1 day') ORDER BY created_at,id LIMIT $2",
            [req.query.after ?? null, req.query.limit],
          )
        ).rows;
        await audit(tx, u!.id, "audit.read", null, req.id);
        return { status: 200, body: { items: rows } };
      });
    },
  });
  app.addHook("onClose", async () => {
    registry.clear();
  });
  await app.ready();
  return app;
}
