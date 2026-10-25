# Web care portal

Start PostgreSQL, configure the existing .env, run migrations, then start the API:

```sh
npm ci
node --env-file=.env --import tsx scripts/migrate.ts
npm run dev
```

Open **http://localhost:3001** when PORT=3001 in .env (default is 3000).
The frontend and REST API share the same server. No separate frontend port, CORS setup, or frontend secret is needed.
Production build: `npm run build`, then `node --env-file=.env dist/src/server.js`.
Run the analytics worker separately using the existing worker instructions.

## Accounts and workflow

- Create an account or sign in using an existing email/password.
- For initial MFA setup, enter the displayed setup key in a TOTP authenticator as a time-based account. Enter its current six-digit code. Existing MFA accounts only need the code; do not enroll again.
- Each patient, doctor and admin needs their own authenticator entry.
- New accounts are patients. An administrator can change the role in **Manage access**, using the ID shown in **My profile**. Role changes revoke that user's sessions.
- An administrator verifies credentials and publishes a doctor directory entry.
- Doctors publish future availability, open assigned consultations, start them, issue prescriptions, and complete consultations.
- Patients filter verified doctors, book available times, cancel booked consultations, and read their prescriptions.
- Admins view daily analytics and bounded audit metadata. They cannot read other users' clinical records.
- Users can edit their name and phone, or sign out of all account sessions.

## Security and boundaries

The plain JavaScript frontend has no third-party runtime scripts. Static files are served only through three explicit routes; filesystem paths are never derived from request input.
Content Security Policy restricts resources to the same origin. Rendered API content is HTML escaped.
Access tokens and MFA setup keys are held only in memory, never localStorage/sessionStorage. Refreshing the page requires signing in again. Access expires after 15 minutes; enrollment/challenge sessions expire after 10 minutes.
Mutations generate idempotency keys and preserve the same key for an identical retry after a network error or server error. Keys are only retained for the current page session.
The API remains responsible for all authorization, validation and audit writes. Hidden controls are not security boundaries.
The server rate limiter also covers frontend requests.

Use HTTPS and a trusted ingress in production. The Kubernetes ingress exposes only the exact homepage/assets and the /v1 API prefix; metrics and health remain internal.
Payment collection, video calls, account recovery, and patient record export are not implemented.
Registration displays a demonstration consent acknowledgement; production legal wording requires policy review.
Audit results are bounded; use the start time and limit to inspect the relevant window.
All appointments display in the browser's local timezone; analytics group by UTC day.

## Browser checks

```sh
npx playwright install chromium
npm run test:e2e
```

On Windows, installed Edge can be used from CMD:

```bat
set PLAYWRIGHT_CHANNEL=msedge
npm run test:e2e
```

The browser test starts an isolated server on 127.0.0.1:4317. Without TEST_DATABASE_URL it uses an in-memory PGlite database. With TEST_DATABASE_URL it resets the explicitly disposable *_test database, just like the integration suite. Never point it at application data.
It exercises real API calls for registration, MFA, admin role changes, doctor publication, availability, booking, prescription, completion, patient read, analytics and audit, plus mobile layout and logout. Screenshots use synthetic test data and are saved in ignored test-results/.
