import { writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { buildApp } from "../src/app.js";
import type { Database } from "../src/db.js";
const db = {
  query: async () => ({ rows: [], rowCount: 0 }),
  transaction: async () => {
    throw new Error("schema only");
  },
  close: async () => {},
} as Database;
const app = await buildApp(
  db,
  {
    databaseUrl: "unused",
    activeKey: "v1",
    keys: { v1: randomBytes(32).toString("base64") },
    tokenPepper: randomBytes(32).toString("hex"),
    metricsToken: randomBytes(32).toString("hex"),
    production: false,
    port: 3000,
  },
  false,
);
await writeFile(
  "docs/openapi.json",
  JSON.stringify(app.swagger(), null, 2) + "\n",
);
await app.close();
