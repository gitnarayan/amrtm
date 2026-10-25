# Amrutam: check every API in Postman

Import `Amrutam.postman_collection.json` and `Amrutam-Local.postman_environment.json` using Postman > Import > Files. Select **Amrutam Local** in the environment selector. Base URL defaults to `http://localhost:3001`.

The collection contains **22 API operations and 27 requests**, including status-transition variants and three authorization failure checks. JSON and embedded script syntax were checked against the local OpenAPI operation inventory. These artifacts have not been executed against your live server, so this is coverage of request definitions, not evidence of passing live tests.

## Before testing

Run the API and worker in separate CMD windows from `C:\Users\NARAYAN\Downloads\production_grade`:

```cmd
npm run dev
```

```cmd
node --env-file=.env --import tsx src/worker-main.ts
```

Use synthetic local accounts. Files contain no passwords, bearer tokens or MFA seeds. Enter credentials in local environment values, not shared values. Marking a field secret only masks it; do not export or share a populated environment. Clear passwords, tokens and OTP values when finished. No Postman workspace synchronization has been performed.

Headers and bearer authorization are already configured. Do not put Content-Type or Idempotency-Key in the URL. Do not click Run on the entire collection: MFA and account switching need manual steps.

## Execution order

1. **Health:** send both requests. Both should return 200; readiness should contain `status: ready`.
2. **Patient:** set `email` and `password` to the synthetic patient account. Register once, or login if the account exists. Public registration always creates a patient.
3. Copy the registration/login response `token` into `challengeToken`. If `kind` is `enroll`, send Enroll and add its `secret` to Google Authenticator as a time-based account. If `kind` is `challenge`, skip Enroll and use the existing authenticator entry.
4. Set `otp` to the current six-digit authenticator code. Send Verify with `challengeToken`. Copy the returned access `token` into `patientToken`. Send GET /v1/me. Enrollment/challenge tokens expire in 10 minutes; access tokens expire in 15 minutes. Refresh access by login + MFA, not by enrollment. A code cannot be reused with a fresh idempotency key in the same time step.
5. **Admin:** use your existing bootstrapped admin. If none exists, create the first one using the bootstrap instructions below. Change `email` and `password`, Login, complete MFA as above, and copy the access token into `adminToken`. Use a separate authenticator entry for each account.
6. **Doctor candidate:** change `email`/`password` to a new synthetic doctor's credentials and Register. Copy its `userId` into `doctorId`. If it already exists, complete login/MFA, temporarily use its access token for GET /v1/me to obtain the ID, then restore the patient's token.
7. **Admin onboarding:** send PATCH /v1/admin/users/{id} with role doctor, then POST /v1/admin/doctors. Both use `adminToken`. Role promotion invalidates existing doctor sessions.
8. **Doctor MFA:** log in again with the doctor's credentials after promotion. Complete enrollment/verification as needed. Save the access token as `doctorToken`. The shared `challengeToken` must always correspond to the account currently being verified.
9. **Profile/directory:** send profile read/update with `patientToken`, publish one future slot with `doctorToken`, then list doctors and slots. Slot creation supplies future timestamps automatically and saves the response ID into `slotId`. Repeated slot creation can overlap; use the saved slot rather than repeatedly creating one.
10. **Booking:** POST /v1/consultations uses `patientToken` and saves `consultationId`. Before sending, replace its dynamic Idempotency-Key with a fresh fixed UUID. Send the same body/key twice: both should return 201 with the same ID. A new key for the booked slot should return 409. This deliberate failure will fail the original 201 assertion; duplicate the request and change its expected status to 409 if saving this check.
11. **Clinical workflow:** list/read the consultation as patient, PATCH status to in_progress as doctor, issue the synthetic prescription, then use Complete consultation. Read the record as patient and verify `completed` plus the prescription. Issuing another prescription after completion should return 409.
12. **Cancellation variant:** create a separate nonoverlapping slot (adjust the slot pre-request script to use 2 days instead of 1), book it, and copy its consultation ID into `cancelConsultationId`. Restore `consultationId` to your completed consultation ID because booking automatically updates it. Send Cancel. A completed consultation cannot be cancelled.
13. **Admin reporting:** run audit and daily analytics using `adminToken`. Empty analytics date fields default to the current UTC day; use the booking creation date if testing later. Allow the worker time to process events. Check counts/freshness as well as HTTP status.
14. **Metrics:** privately copy METRICS_TOKEN from `.env` into `metricsToken`. This is a separate operational credential, not an account access token. Send /metrics and verify Prometheus text.
15. **Negative checks:** missing token -> 401; patient reading admin audit -> 403; admin reading a patient's clinical record -> 404. Those statuses are expected successes in these requests' assertions.
16. **Logout last:** send Logout, then GET /v1/me with the old patient token; it should return 401. The normal profile request expects 200, so create a separate assertion for this revocation test if saving it.

Refresh expired account access tokens as necessary. Do not repeatedly guess OTPs; failed verification is rate-limited.

## First administrator (only if one does not exist)

In CMD, replace the password placeholder before running:

```cmd
cd /d C:\Users\NARAYAN\Downloads\production_grade
set BOOTSTRAP_EMAIL=admin@example.com
set BOOTSTRAP_PASSWORD=REPLACE_WITH_A_UNIQUE_PASSWORD_15_PLUS_CHARACTERS
node --env-file=.env --import tsx scripts/bootstrap.ts
set BOOTSTRAP_PASSWORD=
set BOOTSTRAP_EMAIL=
```

The script refuses to create another admin if one exists. Login and complete MFA; bootstrapping does not bypass MFA.

## Interpreting results

View each request's **Test Results** after Send. Assertions cover status plus selected domain properties. For full workflow evidence, also check correct ownership, stable replay ID, clinical transition state and audit/analytics records. Save a redacted result summary; do not share auth response bodies or enrollment secrets.

400: check required headers/body/UUIDs. 401: missing, wrong-kind, expired or revoked token. 403: wrong role. 409: duplicate account, overlapping slot, booked slot, idempotency conflict or invalid transition. 429: rate limit. 500: inspect server logs using requestId.

These manual checks do not establish parallel-booking correctness, load targets, availability or disaster recovery. Those require separate real-PostgreSQL concurrency, performance and failure tests.
