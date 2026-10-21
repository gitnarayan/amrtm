import "./telemetry.js";
const { config } = await import("./config.js");
const { database } = await import("./db.js");
const { buildApp } = await import("./app.js");
const c = config();
const db = database(c.databaseUrl);
const app = await buildApp(db, c);
await app.listen({ host: "0.0.0.0", port: c.port });
let stopping = false;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, async () => {
    if (stopping) return;
    stopping = true;
    const timeout = setTimeout(() => process.exit(1), 25000).unref();
    await app.close();
    await db.close();
    clearTimeout(timeout);
  });
