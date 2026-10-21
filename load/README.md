# Capacity validation

Run k6 against an isolated staging deployment, not a patient environment. Seed realistic directory and history cardinality before measuring. Supply an MFA-authenticated synthetic user's access token; default duration is five minutes to stay within its 15-minute lifetime. Rotate credentials between runs. Example:

```sh
k6 run -e BASE_URL=https://staging.example -e ACCESS_TOKEN=... -e RATE=100 load/read.js
```

The baseline is a directory-read probe, not a full workload. Shared IP throttling intentionally limits one generator to 300 requests/minute, so a high-rate test will fail until a staging-specific trusted-ingress/rate policy and realistic client distribution are configured. Never disable production rate limits to make results look better.

For acceptance, add representative consultation detail reads, unique slot bookings, doctor transitions and prescriptions with per-user credentials and distinct idempotency keys. Use conflict workloads separately from latency measurements. Run 1-hour steady load, 20× bursts, DB failover, worker pause/recovery, pod rolling restart and noisy-client tests. Preserve raw k6 results, resource charts and commit/image digests. A single synthetic read test cannot establish 100k/day or 99.95% availability.
