import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { FastifyInstance } from "fastify";

// Explicit routes avoid exposing project files or accepting user-controlled paths.
export async function registerFrontend(app: FastifyInstance) {
  const assets = [
    ["/", "index.html", "text/html; charset=utf-8"],
    ["/assets/app.js", "app.js", "text/javascript; charset=utf-8"],
    ["/assets/app.css", "app.css", "text/css; charset=utf-8"],
  ] as const;
  for (const [url, file, type] of assets) {
    const content = await readFile(resolve("public", file), "utf8");
    app.get(url, { schema: { hide: true } }, async (_req, reply) => {
      // Do not upgrade localhost HTTP assets to HTTPS. Production ingress supplies TLS.
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
      );
      return reply.type(type).send(content);
    });
  }
}
