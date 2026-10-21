# Operations and recovery

## Deployment checklist

1. Run CI, review schema migration and scan output. Use a staging database with production-like volume.
2. Provision the RDS Terraform module against an existing VPC. Use encrypted remote Terraform state with locking and scoped IAM. Inspect `terraform plan`; provisioning incurs charges.
3. Apply migrations with the migration-owner identity. Create a separate random runtime login through secret provisioning, run `infra/postgres/runtime-grants.sql` once, and grant `amrutam_runtime` to that login. Do not deploy with database owner credentials.
4. Install the RDS CA bundle and configure the runtime URL with `sslmode=verify-full&sslrootcert=<mounted CA path>`. Configure a secret manager to populate Kubernetes `amrutam-runtime`. Restrict who can read pod environment and secrets.
5. Replace image, domain and DB CIDR placeholders. Install ingress/TLS, metrics-server (HPA), observability stack and compatible CNI network policy. The supplied Compose telemetry storage is for local development only.
   Set `TRUSTED_PROXY_CIDRS` to a comma-separated allowlist of actual ingress proxy CIDRs. Fastify then derives client IP only through those trusted proxies. Never use `0.0.0.0/0` or `::/0` for this setting; ensure clients cannot bypass ingress.
6. Apply base resources and deploy immutable image digests. Run a synthetic MFA + booking + clinical-read smoke test using approved synthetic accounts. Publish DNS after readiness and rollback verification.

GitHub deployment requires `DEPLOY_ROLE_ARN` and `EKS_CLUSTER` environment variables, OIDC federation scoped to repository/ref/environment, and production environment approval rules. Cluster bootstrap and migrations remain explicit operator steps. Grant only deployment patch/read permissions to the deploy role. Keep migration credentials out of the API environment.

## Monitoring

Grafana provisions request-rate, latency and 5xx panels, plus Prometheus/Tempo data sources. Add alerts to an owned paging destination; this repository does not send messages. Check read p95 <200ms, domain write p95 <500ms, 5xx budget burn, outbox oldest age, dead letters, DB connections/CPU/storage/replica failover and backup freshness. Password-auth latency is separately budgeted because memory-hard hashing is deliberate. Measure end-to-end latency externally; API histograms do not include load-balancer/network time.

Logs are JSON stdout for the platform collector. Retain searchable operational logs for the approved period; do not enable request-body/debug SQL logs. Route labels are templates, preventing unbounded cardinality. Trace sampling defaults to 10% in deployment manifests. Validate collector privacy filtering with synthetic secrets before enabling new instrumentations. Prometheus `/metrics` requires `METRICS_TOKEN`; production ingress exposes only `/v1`.

## Incident playbooks

**Elevated 5xx:** correlate request ID and trace ID; inspect readiness and connection saturation. Check migration lock/statement timeout events and database failover. Avoid aggressive restarts during failover. Scale API only within DB connection headroom. Roll back application image if a compatible code release caused errors; do not drop or restore clinical tables as a rollback.

**Booking conflict:** a 409 for a competing slot is expected. Investigate a rise in 503 lock timeouts using `pg_stat_activity` and `pg_locks`. Never remove the unique booking index. Retry ambiguous client failures with their original idempotency key.

**Outbox backlog:** inspect `outbox_oldest_age_seconds`, worker logs and pending count. Restore workers/database first. Unsupported or repeatedly failing events dead-letter after eight attempts. Correct the handler, then an authorized operator can reset selected `dead_at=NULL, attempts=0, available_at=now()` by event ID, recording the operation in the incident audit. Never bulk-replay external side effects without provider idempotency.

**Credential compromise:** suspend the user through the admin API (revokes sessions); investigate metadata audit records. Rotate relevant keys following `security.md`. Restrict admin bootstrap and owner DB access. Avoid logging request payloads during investigation.

## Backup / DR

Terraform enables same-region Multi-AZ and 35-day automated PITR. Multi-AZ is availability, not a substitute for backups. Provision encrypted cross-region copies, destination KMS permissions and immutable audit archive separately before claiming regional DR.

Monthly restore drill: select a point at least 15 minutes in the past, restore RDS to an isolated private network under a new identifier, inject a read-only copy of the appropriate historical keyring, verify migrations/counts/audit continuity, and decrypt sampled synthetic records. Run the API against the restored copy, verify a synthetic booking and outbox worker, measure RPO/RTO, record evidence, then dispose of the drill environment according to policy. Never point production clients at a test restore.

Regional recovery: declare incident, establish last replicated recovery point, restore/promote destination DB, deploy compatible API/worker image and historical keyring, reconcile uncertain payment events with providers, run smoke tests, then update traffic. Target RPO ≤5m and RTO ≤60m are unverified until replication and exercises demonstrate them. Test failback as a distinct operation to avoid divergent writes.

## Maintenance

Run `node --env-file=.env --import tsx scripts/maintenance.ts` daily in development, or compiled `node dist/scripts/maintenance.js` in a controlled scheduled production job. Each invocation removes at most 10,000 expired sessions, rate buckets and >7-day idempotency rows; repeat if backlog remains. Idempotency guarantees apply while records are retained. Expired session cleanup does not govern access; every request checks expiry in SQL.

Do not purge audit/clinical data until retention and legal-hold policy is approved. At scale, archive processed outbox events and receipts together, use batched daily analytics refresh, and implement monthly audit partitions with tested foreign-key changes. Monitor vacuum, index bloat and maintenance windows. Upgrade database and dependencies in staging first.
