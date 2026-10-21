// Optional artifact renderer. Install sharp and a local ffmpeg binary under .tools,
// or set FFMPEG_PATH. Uses only the redacted, synthetic transcript from npm run demo.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
const require = createRequire(resolve(".tools/package.json"));
const sharp = require("sharp");
const ffmpeg =
  process.env.FFMPEG_PATH ??
  resolve(".tools/node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe");
const transcript = JSON.parse(
  readFileSync("demo-output/transcript.json", "utf8"),
);
const find = (label) => transcript.steps.find((s) => s.label === label);
const booking = find("Book consultation").response;
const scenes = [
  [
    "A safer path from slot to care",
    "AMRUTAM / BACKEND DEMONSTRATION",
    [
      "Node.js 24 + TypeScript + PostgreSQL",
      "Five-minute captioned walkthrough • no audio",
      "Evidence comes from executed API requests in PGlite.",
      "Synthetic data only; no production system is shown.",
      "Targets: 100k consultations/day and 99.95% availability.",
      "These targets require staging load and failure testing.",
    ],
  ],
  [
    "One source of truth",
    "01 / ARCHITECTURE",
    [
      "TLS ingress → stateless API replicas → PostgreSQL",
      "Modules: identity, directory, scheduling and clinical care",
      "Clinical write + audit + outbox + response commit together.",
      "Independent workers process durable jobs.",
      "Prometheus metrics • structured logs • OTel traces",
      "Cloud manifests require existing VPC, cluster and secrets.",
    ],
  ],
  [
    "MFA gates every clinical action",
    "02 / IDENTITY",
    [
      `POST /auth/register → ${find("Patient registration").status} / enrollment token`,
      `Enrollment token → GET /doctors → ${find("Enrollment token cannot access clinical API").status}`,
      `POST /auth/mfa/enroll → ${find("Enroll authenticator").status} / secret redacted`,
      `POST /auth/mfa/verify → ${find("Verify MFA").status} / access token`,
      "TOTP counter prevents replay; access expires in 15 minutes.",
      "Doctor/admin demo sessions are pre-provisioned fixtures.",
    ],
  ],
  [
    "From availability to reservation",
    "03 / BOOKING",
    [
      `Doctor publishes future slot → ${find("Doctor publishes availability").status}`,
      `Patient filters verified directory → ${find("Search doctors").status}`,
      `Patient books slot → ${find("Book consultation").status}`,
      `Consultation: ${booking.id}`,
      "Status: booked • payment: not_collected",
      "The implementation does not simulate a captured payment.",
    ],
  ],
  [
    "Retries preserve the same result",
    "04 / CONCURRENCY",
    [
      `Identical key + payload → ${find("Retry returns identical booking").status}`,
      "Replay returns the same consultation ID.",
      `Competing patient, same slot → ${find("Competing patient cannot double-book").status}`,
      "Advisory lock serializes each actor/idempotency key.",
      "Slot lock + partial unique index prevent double booking.",
      "Real multi-connection PostgreSQL tests are configured in CI.",
    ],
  ],
  [
    "Care records stay with their participants",
    "05 / CLINICAL LIFECYCLE",
    [
      `Unrelated patient reads consultation → ${find("Other patient cannot read record").status}`,
      `Assigned doctor starts → ${find("Doctor starts consultation").status}`,
      `Assigned doctor issues prescription → ${find("Doctor issues prescription").status}`,
      `Doctor completes → ${find("Doctor completes consultation").status}`,
      `Patient reads own prescription → ${find("Patient reads own prescription").status}`,
      "AES-256-GCM encrypts prescription content with record AAD.",
    ],
  ],
  [
    "Work survives an interrupted request",
    "06 / RELIABILITY",
    [
      `Outbox events processed: ${find("Worker drains transactional outbox").processed}`,
      "Workers claim rows with FOR UPDATE SKIP LOCKED.",
      "Projection update + receipt + completion are atomic.",
      "Exponential retry with jitter; dead-letter after 8 failures.",
      `Admin aggregate endpoint → ${find("Admin analytics").status}`,
      "Aggregate responses expose freshness timestamps.",
    ],
  ],
  [
    "Security controls are reviewable",
    "07 / SECURITY AND AUDIT",
    [
      "Strict schemas • parameterized SQL • role + owner checks",
      "Mandatory TOTP • scrypt passwords • revoked sessions",
      "Audit trigger rejects UPDATE and DELETE.",
      "Non-root containers and least-privilege SQL grant template",
      "Threat model names residual risks and release gates.",
      "Compliance and independent penetration review remain open.",
    ],
  ],
  [
    "Delivery includes the operating model",
    "08 / DELIVERY AND OPERATIONS",
    [
      "README + OpenAPI + four-page architecture + runbooks",
      "Automated security and API/SQL integration tests",
      "CI: PostgreSQL 17, type-check, tests, image/dependency scans",
      "Docker Compose • Kubernetes • private Multi-AZ RDS Terraform",
      "Grafana dashboard, Prometheus alerts, OTel collector",
      "PITR / key recovery / outage response documented",
    ],
  ],
  [
    "What is verified, and what comes next",
    "09 / HANDOFF",
    [
      "Verified: build, local PostgreSQL-engine tests, API demo.",
      "Not claimed: measured scale, SLA or applied cloud deployment.",
      "Next: real-server CI, soak tests, failover and restore drills.",
      "Connect payment, video and notifications before product launch.",
      "Review docs/security.md and docs/verification.md.",
      "Reproduce this walkthrough with npm run demo.",
    ],
  ],
];
const escape = (s) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
mkdirSync(".video-frames", { recursive: true });
for (let i = 0; i < scenes.length; i++) {
  const [title, kicker, lines] = scenes[i];
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="900"><rect width="1600" height="900" fill="#0b1821"/><rect x="64" y="64" width="56" height="6" rx="3" fill="#53ddbc"/><text x="64" y="124" fill="#53ddbc" font-family="Arial" font-size="22" letter-spacing="3">${escape(kicker)}</text><text x="64" y="212" fill="#f4f8fa" font-family="Arial" font-size="48" font-weight="bold">${escape(title)}</text><line x1="64" y1="257" x2="1536" y2="257" stroke="#31414b"/>${lines.map((line, j) => `<circle cx="78" cy="${327 + j * 68}" r="4" fill="#53ddbc"/><text x="102" y="${337 + j * 68}" fill="${j === 0 ? "#ffffff" : "#c0ced5"}" font-family="Arial" font-size="29">${escape(line)}</text>`).join("")}<rect x="64" y="799" width="1472" height="2" fill="#31414b"/><rect x="64" y="799" width="${(1472 * (i + 1)) / 10}" height="3" fill="#53ddbc"/><text x="64" y="849" fill="#839aa8" font-family="Arial" font-size="19">EXECUTED API EVIDENCE / SYNTHETIC DATA / CAPTIONED WALKTHROUGH</text><text x="1450" y="849" fill="#53ddbc" font-family="Arial" font-size="22">${String(i + 1).padStart(2, "0")} / 10</text></svg>`;
  await sharp(Buffer.from(svg))
    .png()
    .toFile(`.video-frames/${String(i).padStart(2, "0")}.png`);
}
const args = [
  "-y",
  "-framerate",
  "1/30",
  "-i",
  ".video-frames/%02d.png",
  "-c:v",
  "libx264",
  "-r",
  "10",
  "-pix_fmt",
  "yuv420p",
  "-t",
  "300",
  "-movflags",
  "+faststart",
  "docs/demo.mp4",
];
const result = spawnSync(ffmpeg, args, { stdio: "inherit", windowsHide: true });
if (result.status !== 0) throw Error("Video rendering failed");
copyFileSync("demo-output/transcript.json", "docs/demo-transcript.json");
writeFileSync(
  "docs/demo-video-metadata.json",
  JSON.stringify(
    {
      durationSeconds: 300,
      scenes: 10,
      format: "1600x900 H.264, 10fps",
      audio: false,
      description:
        "Captioned evidence walkthrough, not a screen recording of deployed infrastructure",
    },
    null,
    2,
  ),
);
