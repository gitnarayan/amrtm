import type { Db, Database } from "./db.js";
import type { Config } from "./config.js";
import type { cipher } from "./security.js";
import type { Result } from "./transactions.js";
export type Identity = {
  id: string;
  role: string;
  kind: string;
  token_hash: string;
};
export type Options = {
  method: "GET" | "POST" | "PATCH";
  url: string;
  summary: string;
  body?: any;
  querystring?: any;
  params?: any;
  public?: boolean;
  kinds?: string[];
  handler: (req: any, tx: Db, u: Identity | null) => Promise<Result>;
};
export type RouteContext = {
  route: (o: Options) => void;
  db: Database;
  c: Config;
  crypt: ReturnType<typeof cipher>;
  role: (u: Identity, ...roles: string[]) => void;
  session: (
    tx: Db,
    user: string,
    kind: string,
  ) => Promise<{ token: string; kind: string; expiresIn: number }>;
};
