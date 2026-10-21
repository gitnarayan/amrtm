import { randomBytes } from "node:crypto";
import { writeFileSync, mkdirSync } from "node:fs";
const secret = () => randomBytes(32).toString("hex");
const password = secret();
const metrics = secret();
writeFileSync(
  ".env",
  `POSTGRES_PASSWORD=${password}\nDATABASE_URL=postgres://amrutam:${password}@localhost:5432/amrutam\nDATA_KEYS={"v1":"${randomBytes(32).toString("base64")}"}\nACTIVE_DATA_KEY=v1\nTOKEN_PEPPER=${secret()}\nMETRICS_TOKEN=${metrics}\nGRAFANA_PASSWORD=${secret()}\nPORT=3000\nNODE_ENV=development\n`,
  { flag: "wx" },
);
mkdirSync(".secrets", { recursive: true });
writeFileSync(".secrets/metrics_token", metrics, { flag: "wx" });
console.log(
  "Created .env with fresh local secrets. Existing files are never overwritten.",
);
