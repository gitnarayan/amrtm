-- Run as migration owner after migrations. Create a LOGIN with a generated secret
-- separately through your secrets manager; NEVER use the migration owner at runtime.
CREATE ROLE amrutam_runtime NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION;
GRANT CONNECT ON DATABASE amrutam TO amrutam_runtime;
GRANT USAGE ON SCHEMA public TO amrutam_runtime;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT SELECT, INSERT, UPDATE, DELETE ON users, profiles, doctors, availability_slots,
 consultations, prescriptions, payments, sessions, idempotency, outbox,
 job_receipts, daily_analytics, rate_limits TO amrutam_runtime;
GRANT SELECT, INSERT ON audit_logs TO amrutam_runtime;
GRANT SELECT ON schema_migrations TO amrutam_runtime;
-- GRANT amrutam_runtime TO <runtime_login>; via controlled provisioning.
-- No ownership, DDL, TRUNCATE, audit UPDATE/DELETE or BYPASSRLS granted.
