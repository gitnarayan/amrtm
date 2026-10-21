export type Config = {
  databaseUrl: string;
  keys: Record<string, string>;
  activeKey: string;
  tokenPepper: string;
  port: number;
  production: boolean;
  metricsToken: string;
  trustedProxies?: string[];
};
export function config(env = process.env): Config {
  const keys = JSON.parse(env.DATA_KEYS ?? "{}") as Record<string, string>;
  const activeKey = env.ACTIVE_DATA_KEY ?? "v1";
  if (
    !keys[activeKey] ||
    Object.entries(keys).some(
      ([id, k]) =>
        !/^[a-zA-Z0-9_-]+$/.test(id) ||
        typeof k !== "string" ||
        Buffer.from(k, "base64").length !== 32,
    )
  )
    throw new Error("DATA_KEYS must contain base64 32-byte keys");
  if ((env.TOKEN_PEPPER?.length ?? 0) < 32)
    throw new Error("TOKEN_PEPPER must be at least 32 characters");
  if ((env.METRICS_TOKEN?.length ?? 0) < 32)
    throw new Error("METRICS_TOKEN must be at least 32 characters");
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL required");
  const production = env.NODE_ENV === "production";
  if (
    production &&
    new URL(env.DATABASE_URL).searchParams.get("sslmode") !== "verify-full"
  )
    throw new Error("Production requires PostgreSQL sslmode=verify-full");
  return {
    databaseUrl: env.DATABASE_URL,
    keys,
    activeKey,
    tokenPepper: env.TOKEN_PEPPER!,
    port: Number(env.PORT ?? 3000),
    production,
    metricsToken: env.METRICS_TOKEN!,
    trustedProxies: env.TRUSTED_PROXY_CIDRS?.split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  };
}
