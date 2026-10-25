# Amrutam telemedicine backend

TypeScript / Node.js 24 / Fastify / PostgreSQL 17. A modular backend with database-enforced booking concurrency, mandatory TOTP MFA, record-level authorization, encrypted clinical fields, transactional idempotency, an outbox worker, and operational configuration.

**Status:** executable reference implementation for production review. The 100k consultations/day, p95 read <200ms / domain write <500ms, and 99.95% availability figures are targets, not measured guarantees. See [verification](docs/verification.md) and [release gates](docs/security.md). Payment collection, video transport, notification delivery, identity verification and clinical approval are external integrations; no simulated charge is reported as successful.

## Quick start

Requires Node.js 24 and Docker Compose v2. From the repository root:

```sh
npm ci
node scripts/dev-env.mjs
docker compose up --build -d
```

The script generates local secrets in ignored `.env` and `.secrets/`. It refuses to overwrite an existing `.env`. The migration container completes before the API and worker start.

| Service | Local address |
|---|---|
| API | http://localhost:3000 |
| Liveness / database readiness | `/health/live` / `/health/ready` |
| Grafana | http://localhost:3001 (`admin`, generated `GRAFANA_PASSWORD`) |
| Prometheus | http://localhost:9090 |
| API schema | [docs/openapi.json](docs/openapi.json) |

For API development with only PostgreSQL in Docker:

```sh
docker compose up postgres -d
node --env-file=.env --import tsx scripts/migrate.ts
node --env-file=.env --import tsx src/server.ts
# Another terminal:
node --env-file=.env --import tsx src/worker-main.ts
```

PowerShell users can use `npm.cmd` if execution policy blocks `npm.ps1`. Production uses compiled JavaScript, not tsx.

## Bootstrap and workflow

1. Set `BOOTSTRAP_EMAIL` and a unique 15+ character `BOOTSTRAP_PASSWORD` in your shell. Run `node --env-file=.env --import tsx scripts/bootstrap.ts` (or run the compiled script in the API container). The script permits only the first admin. Remove these variables afterwards.
2. Register a patient at `POST /v1/auth/register`, supplying `email`, `password`, `name`, `consentVersion: "2026-01"`. Login existing users at `POST /v1/auth/login`.
3. Using the returned enrollment bearer token, call `POST /v1/auth/mfa/enroll` with `{}`. Import its `otpauth://` URI into an authenticator. Call `POST /v1/auth/mfa/verify` with `{"code":"123456"}`. Only the returned **access** token can use domain APIs. Subsequent logins require a fresh code; codes cannot be reused in the same 30-second interval.
4. A doctor registers normally. An MFA-authenticated admin grants `doctor` role using `PATCH /v1/admin/users/:id` and verifies directory details via `POST /v1/admin/doctors`. Role changes revoke all existing sessions; login again.
5. Doctor publishes slots, patient searches and books, assigned doctor starts consultation, issues prescription and completes it. Patients may cancel a booked consultation. Admins can read aggregates and audit metadata, but cannot access clinical records through admin privileges.

Every POST/PATCH requires an `Idempotency-Key` of 16–128 letters, digits, `_` or `-`. Use a fresh UUID for each intended action and retain it for retries. An exact replay returns the original status/body; changing payload or endpoint with that key returns 409. Failed transactions are rolled back and may be retried. Logout revokes the credential itself, so a logout retry returns 401; the desired revocation is already complete.

```sh
curl -X POST http://localhost:3000/v1/consultations \
  -H "Authorization: Bearer $ACCESS_TOKEN" \
  -H "Idempotency-Key: $REQUEST_UUID" \
  -H 'Content-Type: application/json' \
  -d '{"slotId":"<slot UUID>"}'
```

Tokens expire after 15 minutes (enrollment/challenges after 10). There is no refresh-token or self-service MFA recovery endpoint. Recovery requires a separately approved identity-verification process; never bypass MFA by changing database flags as a routine support action.

## Tests and demo

```sh
npm run check
npm test
npm run build
npm run schema
npm run demo
```

Default tests run actual PostgreSQL SQL in embedded PGlite, without Docker. To exercise multi-connection contention against PostgreSQL 17, set `TEST_DATABASE_URL` to a **disposable database whose name ends in `_test`**, then run `npm run test:integration`. This test drops that database's public schema. CI runs this real-PostgreSQL variant. Do not use production credentials.

The demo uses an isolated in-memory database and synthetic users, performs real API requests through Fastify injection, and writes redacted evidence to `demo-output/transcript.json`. Watch the [five-minute captioned video](docs/demo.mp4) or read the [walkthrough](docs/demo.md). The video is a silent evidence presentation, not a recording of deployed infrastructure. The demo never changes a running deployment.

## Repository map

| Path | Responsibility |
|---|---|
| `src/modules/` | Auth/profile, directory/availability, consultation/prescription routes |
| `src/app.ts`, `src/http.ts` | Dependency injection, validation, observability, administrative reads |
| `src/security.ts`, `src/transactions.ts` | Cryptography, TOTP, idempotency, auditing, rate limits |
| `src/worker.ts` | Transactional jobs, retries, dead letters, analytics |
| `migrations/` | Versioned PostgreSQL schema and constraints |
| `infra/` | Compose monitoring, Kubernetes, RDS Terraform, SQL grants |
| `.github/workflows/` | Test, scan, build, publish, operator-triggered deployment |
| `tests/`, `load/` | Security/integration tests and k6 load scenario |

## Production deployment

Use [architecture](docs/architecture.md), [operations](docs/operations.md), [threat model](docs/security.md), and [verification](docs/verification.md). Terraform provisions a private Multi-AZ encrypted RDS instance in an **existing VPC**. Kubernetes manifests target an **existing cluster**, ingress controller, observability namespace and secret-management integration. They do not provision an entire cloud account or cluster.

Supply `DATABASE_URL` (runtime login, `sslmode=verify-full` and trusted RDS CA), `DATA_KEYS` (JSON keyring of base64 32-byte keys), `ACTIVE_DATA_KEY`, `TOKEN_PEPPER`, `METRICS_TOKEN` through the secret manager. Use a separate `MIGRATION_DATABASE_URL` for schema changes. Never commit secrets or Terraform state. Set DNS/TLS, actual DB subnet CIDR, namespace networking, secret `amrutam-runtime`, and immutable image digest before applying Kubernetes manifests.

The deployment workflow requires configured AWS OIDC trust, an existing EKS cluster, environment protection and scoped RBAC. It updates existing deployments; it does not silently provision cloud resources. No infrastructure has been applied by this project setup.

## Web care portal

Open http://localhost:3001 after starting the backend with PORT=3001. The built-in portal supports patient, doctor and admin workflows, including MFA. See [frontend setup and walkthrough](docs/frontend.md).
