# Verification record

Local environment: Windows, Node.js 24.19.0. Docker, PostgreSQL server CLI, Terraform and Kubernetes CLI were not available at implementation start.

The default integration suite uses PGlite, an embedded PostgreSQL engine. It validates SQL constraints, rollback, encryption, API authorization and replay semantics. PGlite serializes its transaction access; parallel API test calls here are **not proof of real multi-connection row-lock behavior**. CI config runs the same suite against PostgreSQL 17 with a connection pool. CI has not been executed remotely from this workspace.

Local results (21 October 2026): TypeScript strict build/check passed; 19 tests passed across two source test files; the synthetic end-to-end demo passed; 11 YAML files parsed; npm audit reported zero known vulnerabilities. OpenAPI was generated from registered routes. A 300-second silent captioned MP4 was rendered and a representative frame visually checked. Docker builds, real-server PostgreSQL concurrency, Terraform/provider validation, Kubernetes deployment, image scanning and remote CI were not run locally. Their workflows/configuration are supplied. Do not interpret tests as a load test, SLA, security certification, or a successful infrastructure deployment.

Required release measurements:

| Requirement | Evidence required |
|---|---|
| 100k consultations/day | Production-sized seed, sustained ~700 mixed req/s peak hypothesis, ≥1h soak; compare worker backlog and database capacity |
| Read p95 <200ms | k6 external measurements by endpoint, representative cardinality and response sizes |
| Domain write p95 <500ms | Authenticated write tests with unique slots/keys, include commit and outbox enqueue |
| Authentication performance | Separate password/MFA rate, memory and overload limits; do not remove scrypt cost to satisfy unrelated domain latency |
| 99.95% availability | External SLI over agreed window; zone/DB failover and rolling-upgrade exercises |
| RPO/RTO | Timed isolated restore and regional recovery drill, including encryption keys |
| Security | Negative tests plus independent penetration and clinical compliance review |

Known scope limits: no real payment capture/refund, video room provider, notifications, self-service password/MFA recovery, off-host immutable audit export or patient data-export workflow. Terraform requires an existing VPC; Kubernetes requires an existing cluster/controllers/secrets. Monthly partitioning, read replicas and Redis caching are documented scale paths rather than active components.
