# Five-minute demonstration

[Watch the five-minute captioned video](demo.mp4). This silent video presents results from the executed synthetic API demo and architecture captions; it is not a live deployment screen recording. [Redacted transcript](demo-transcript.json) accompanies it.

Run `npm run demo` to produce a redacted transcript from an isolated synthetic environment. Display the repository and transcript while recording the following walkthrough. No production credentials are needed.

| Time | Show / explain |
|---|---|
| 0:00–0:40 | Architecture diagram: stateless API, PostgreSQL, transactional outbox, independent workers, telemetry. Explain target scale versus measured evidence. |
| 0:40–1:25 | Demo patient registration, MFA enrollment and verification. Enrollment tokens cannot call domain endpoints. Show only redacted token results. |
| 1:25–2:15 | Doctor creates slot; patient books; identical idempotency retry returns same consultation; second patient gets 409. Show unique index and transaction boundary. |
| 2:15–3:00 | Wrong user gets 404; doctor starts consultation, issues prescription, completes; patient reads prescription. Show encrypted database field without patient content. |
| 3:00–3:40 | Worker processes outbox, admin sees aggregates; audit is append-only. Explain retries/dead letters and no external payment capture claim. |
| 3:40–4:20 | Tests, OpenAPI, CI and non-root container. Explain PGlite versus real-PostgreSQL CI coverage. |
| 4:20–5:00 | Grafana/alert configurations, security checklist and DR runbook. State that scale/SLA and cloud deployment require staging validation. |

The executable demo is an API walkthrough; it is not a recording of deployed infrastructure. A narrated screen recording can be made with the recorder of your choice using this timeline.
