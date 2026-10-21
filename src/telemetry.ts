import { NodeSDK } from "@opentelemetry/sdk-node";
import { getNodeAutoInstrumentations } from "@opentelemetry/auto-instrumentations-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
// Loaded before Fastify/pg. Disable query text and filesystem instrumentation to reduce PHI exposure.
const sdk = new NodeSDK({
  traceExporter: new OTLPTraceExporter(),
  instrumentations: [
    getNodeAutoInstrumentations({
      "@opentelemetry/instrumentation-fs": { enabled: false },
      "@opentelemetry/instrumentation-pg": {
        enhancedDatabaseReporting: false,
        responseHook: (span) => {
          span.setAttribute("db.statement", "[REDACTED]");
        },
      },
      "@opentelemetry/instrumentation-http": {
        requestHook: (span) => {
          span.setAttribute("url.query", "[REDACTED]");
        },
      },
    }),
  ],
});
if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT) {
  sdk.start();
  process.once("SIGTERM", () => void sdk.shutdown());
}
