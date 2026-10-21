import "./telemetry.js";
import { config } from "./config.js";
import { database } from "./db.js";
import { processOne } from "./worker.js";
import { setTimeout } from "node:timers/promises";
const db = database(config().databaseUrl);
let running = true;
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    running = false;
  });
while (running) {
  try {
    const result = await processOne(db);
    if (result === "idle") await setTimeout(500);
    else
      process.stdout.write(
        JSON.stringify({
          level: result === "dead" ? "error" : "info",
          event: "job",
          result,
        }) + "\n",
      );
  } catch {
    process.stderr.write(
      '{"level":"error","event":"worker_database_failure"}\n',
    );
    await setTimeout(2000);
  }
}
await db.close();
