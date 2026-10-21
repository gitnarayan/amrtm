CREATE TABLE users (
 id uuid PRIMARY KEY, email text NOT NULL UNIQUE, password_hash text NOT NULL,
 role text NOT NULL DEFAULT 'patient' CHECK (role IN ('patient','doctor','admin')),
 active boolean NOT NULL DEFAULT true, mfa_secret text, mfa_enabled boolean NOT NULL DEFAULT false,
 last_totp_step bigint NOT NULL DEFAULT -1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE profiles (user_id uuid PRIMARY KEY REFERENCES users(id), encrypted_data text NOT NULL, consent_version text NOT NULL, consent_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE doctors (id uuid PRIMARY KEY REFERENCES users(id), display_name text NOT NULL, specialty text NOT NULL, languages text[] NOT NULL, fee_paise integer NOT NULL CHECK(fee_paise >= 0), verified boolean NOT NULL DEFAULT false);
CREATE INDEX doctors_search ON doctors(specialty, id) WHERE verified;
CREATE TABLE availability_slots (id uuid PRIMARY KEY, doctor_id uuid NOT NULL REFERENCES doctors(id), starts_at timestamptz NOT NULL, ends_at timestamptz NOT NULL, CHECK(ends_at > starts_at), UNIQUE(doctor_id, starts_at));
CREATE INDEX slots_lookup ON availability_slots(doctor_id, starts_at);
CREATE TABLE consultations (id uuid PRIMARY KEY, patient_id uuid NOT NULL REFERENCES users(id), doctor_id uuid NOT NULL REFERENCES doctors(id), slot_id uuid NOT NULL REFERENCES availability_slots(id), status text NOT NULL CHECK(status IN ('booked','in_progress','completed','cancelled')), created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX single_booking ON consultations(slot_id) WHERE status <> 'cancelled';
CREATE INDEX patient_consultations ON consultations(patient_id, created_at DESC, id);
CREATE INDEX doctor_consultations ON consultations(doctor_id, created_at DESC, id);
CREATE INDEX consultation_analytics ON consultations(created_at, status);
CREATE TABLE prescriptions (id uuid PRIMARY KEY, consultation_id uuid NOT NULL REFERENCES consultations(id), doctor_id uuid NOT NULL REFERENCES doctors(id), encrypted_data text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX prescriptions_consultation ON prescriptions(consultation_id);
CREATE TABLE payments (id uuid PRIMARY KEY, consultation_id uuid NOT NULL UNIQUE REFERENCES consultations(id), amount_paise integer NOT NULL CHECK(amount_paise >= 0), currency text NOT NULL DEFAULT 'INR', status text NOT NULL CHECK(status IN ('not_collected','void')), created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE sessions (token_hash text PRIMARY KEY, user_id uuid NOT NULL REFERENCES users(id), kind text NOT NULL CHECK(kind IN ('enroll','challenge','access')), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE idempotency (scope text NOT NULL, key text NOT NULL, request_hash text NOT NULL, encrypted_response text NOT NULL, status_code integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(scope,key));
CREATE TABLE audit_logs (id uuid PRIMARY KEY, actor_id uuid, action text NOT NULL, resource_id uuid, request_id text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX audit_time ON audit_logs(created_at, id);
CREATE FUNCTION immutable_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit records are append-only'; END $$;
CREATE TRIGGER audit_immutable BEFORE UPDATE OR DELETE ON audit_logs FOR EACH ROW EXECUTE FUNCTION immutable_audit();
CREATE TABLE outbox (id uuid PRIMARY KEY, topic text NOT NULL, aggregate_id uuid NOT NULL, attempts integer NOT NULL DEFAULT 0, available_at timestamptz NOT NULL DEFAULT now(), processed_at timestamptz, dead_at timestamptz, created_at timestamptz NOT NULL DEFAULT now());
CREATE INDEX outbox_pending ON outbox(available_at) WHERE processed_at IS NULL AND dead_at IS NULL;
CREATE TABLE job_receipts (event_id uuid PRIMARY KEY REFERENCES outbox(id), processed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE daily_analytics (day date PRIMARY KEY, booked bigint NOT NULL, completed bigint NOT NULL, cancelled bigint NOT NULL, refreshed_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE rate_limits (bucket text PRIMARY KEY, hits integer NOT NULL, expires_at timestamptz NOT NULL);
