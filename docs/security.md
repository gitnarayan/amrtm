# Security checklist and threat model

## Assets and trust boundaries

| Classification | Data | Handling |
|---|---|---|
| Restricted clinical | prescriptions, consultation relationships | AES-GCM for clinical content; encrypted storage; patient/assigned-doctor access |
| Sensitive identity | email, profile, TOTP seed, access credentials | profile/seed encryption; token keyed hashes; email searchable only inside DB |
| Operational sensitive | audit actor/resource IDs, encrypted idempotency bodies | restricted runtime grants; metadata-only logs; limited administrative access |
| Public after verification | doctor display name, specialty, fee, languages | approved by admin; current API still requires authentication |

Boundaries: internet → TLS ingress → API → PostgreSQL; API → telemetry collector; worker → database; operator/CI → cloud and secrets manager. External payment/video/notification systems are not connected. The database owner and secret-manager administrator remain privileged trust assumptions. This is a single-organization application; there is no tenant-isolation claim.

## Attack surface and mitigations

| Threat | Implemented control | Residual risk / validation |
|---|---|---|
| Credential stuffing / brute force | scrypt N=131072,r=8,p=1; 15-character minimum; MFA; shared account/IP counters; bounded password concurrency | Edge WAF and compromised-password screening remain deployment work; distributed attack protection needs load tests |
| MFA bypass / replay | Enrollment/challenge tokens cannot access domain APIs; monotonic TOTP step updated under row lock; all roles require MFA | TOTP can be phished; adopt WebAuthn/managed IdP for stronger assurance; verified recovery process not implemented |
| Broken object authorization | Own-patient/assigned-doctor predicates, negative tests, admin clinical access denied | In-flight requests may finish while access is being revoked; next request is denied |
| Privilege escalation / mass assignment | Strict JSON schemas; public registration always patient; admin changes revoke sessions | Admin onboarding and verification must include human credential checks |
| SQL injection | Parameterized SQL; bounded filters and pagination | Any future dynamic sorting must use explicit allowlists |
| Double booking / request replay | Slot lock, partial unique index, transactional idempotency, request-body digest | All scheduling writes must use the API; direct privileged DB writes can bypass time-overlap service logic |
| Tampering / secret disclosure | AES-256-GCM with record AAD; opaque credentials; random local secrets; startup validation | Key compromise exposes retained data; keyring is supplied in environment, so process/debug access must be restricted |
| Audit repudiation | Transactional metadata audit; trigger rejects update/delete; runtime grants omit DDL/TRUNCATE/audit mutation | Owner can bypass triggers; export to immutable WORM storage and restrict owner access before regulated use |
| PHI in telemetry | No body logging; generated IDs; auth redaction; SQL and URL removal in collector | Validate exported traces after instrumentation upgrades; free-text errors intentionally not logged |
| CSRF / CORS / browser abuse | Bearer header authentication, no ambient cookies, no permissive CORS, security headers | Web client must protect tokens against XSS; cookie auth requires a separate CSRF design |
| DoS / resource exhaustion | 32KB body cap, schema limits, shared counters, pool/statement/lock timeouts, CPU autoscaling | Database-backed limiter is a capacity dependency; use edge filtering and consider Redis under measured pressure |
| Supply-chain compromise | Lockfile, npm audit, Trivy image scan, SBOM/provenance publish | Pin action/image digests and review scan exceptions before release; tags in sample infra require periodic updates |
| SSRF / insecure webhooks | No user-controlled outbound URL fetch or webhook endpoint | Future integrations require URL allowlists, signature verification and event IDs |
| Stolen session | 15-minute expiry, keyed-hash storage, revoke-all logout, revocation on role/suspension | Token held in client remains a bearer credential; no device binding or refresh rotation |

## Key and retention operations

`DATA_KEYS` maps version IDs to base64 32-byte encryption keys. Add a new version to the keyring everywhere, switch `ACTIVE_DATA_KEY`, then re-encrypt existing rows in bounded audited batches. Associated data must remain `profile:<id>`, `mfa:<id>`, `prescription:<id>` and `idempotency:<scope>:<key>`. Validate decryptions before retiring any old key. Keep old keys available for retained snapshots. Re-encryption automation and KMS-envelope-per-record keys are future hardening; storage KMS rotation is configured in Terraform.

Rotating `TOKEN_PEPPER` invalidates existing sessions and changes account-rate-limit hashes and public idempotency scopes. Perform as a coordinated security operation and require reauthentication. Rotate metrics credentials independently. Never print secrets in deployment logs or store them in Terraform state.

The maintenance script deletes expired sessions, expired rate buckets, and idempotency responses older than seven days in bounded batches. It deliberately does not delete clinical/audit records. Clinical retention, consent wording, patient rights/export, legal holds, minors/guardian workflows and approved prescription rules require jurisdiction-specific policy and counsel. A consent string is evidence of a captured application event, not proof of informed legal consent. No HIPAA, Indian telemedicine, DPDP or other compliance certification is claimed.

## Checklist

Implemented and tested:

- [x] Required MFA, salted password hashing, session expiry/revocation.
- [x] RBAC plus record ownership; no admin backdoor to prescriptions.
- [x] Strict request validation, parameterized SQL, request-size limits.
- [x] Atomic idempotency, booking concurrency constraints and audit writes.
- [x] Encrypted clinical fields with tamper detection and key-version support.
- [x] Restricted metrics and no clinical payloads in normal logs.
- [x] Dependency/image scans in CI; non-root container; network policy template.

Before production approval:

- [ ] Verify doctor identity/licensing and approve clinical/consent policies.
- [ ] Configure TLS, trusted ingress IP handling, secret management and least-privilege runtime SQL grants.
- [ ] Pin CI actions/container images to reviewed digests; run deployed dependency and image scans.
- [ ] Perform independent penetration test, restore drill, load test and zone-failure exercise.
- [ ] Establish identity-verified MFA recovery, incident response, breach reporting and access reviews.
- [ ] Configure off-host append-only audit archive, alerts/on-call, external probes and production log storage.
- [ ] Validate data residency, retention, deletion/export and legal-hold requirements.
- [ ] Integrate real payment/video/notification providers with contract/security tests if required for launch.

Primary guidance: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html), [OWASP MFA](https://cheatsheetseries.owasp.org/cheatsheets/Multifactor_Authentication_Cheat_Sheet.html), [OWASP secrets management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html).
