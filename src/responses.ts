import { obj, str, uuid } from "./schema.js";
const date = { type: "string", format: "date-time" };
const generic = { type: "object", additionalProperties: true };
const consultation = obj({
  id: uuid,
  patient_id: uuid,
  doctor_id: uuid,
  slot_id: uuid,
  status: {
    type: "string",
    enum: ["booked", "in_progress", "completed", "cancelled"],
  },
  created_at: date,
  updated_at: date,
});
const directory = obj({
  id: uuid,
  display_name: str(),
  specialty: str(),
  languages: { type: "array", items: str() },
  fee_paise: { type: "integer" },
  verified: { type: "boolean" },
});
const slot = obj({ id: uuid, doctor_id: uuid, starts_at: date, ends_at: date });
const list = (item: any, cursor = true) =>
  obj({
    items: { type: "array", items: item },
    ...(cursor ? { nextCursor: { type: "string", nullable: true } } : {}),
  });
const session = obj({
  token: str(),
  kind: { type: "string", enum: ["access", "enroll", "challenge"] },
  expiresIn: { type: "integer" },
});
export function successSchema(method: string, path: string): any {
  if (path === "/v1/auth/register")
    return obj({ ...session.properties, userId: uuid });
  if (path === "/v1/auth/login" || path === "/v1/auth/mfa/verify")
    return session;
  if (path === "/v1/auth/mfa/enroll")
    return obj({ secret: str(), uri: str(1000) });
  if (path === "/v1/auth/logout") return obj({ revoked: { type: "boolean" } });
  if (path === "/v1/me")
    return method === "GET"
      ? obj({ id: uuid, role: str(), profile: { ...generic, nullable: true } })
      : obj({ updated: { type: "boolean" } });
  if (path === "/v1/admin/users/:id")
    return obj({ updated: { type: "boolean" } });
  if (path === "/v1/doctors") return list(directory);
  if (path === "/v1/doctors/:id/slots") return list(slot);
  if (path === "/v1/consultations" && method === "GET")
    return list(consultation);
  if (path === "/v1/consultations" && method === "POST")
    return obj({
      id: uuid,
      status: { const: "booked", type: "string" },
      paymentStatus: { const: "not_collected", type: "string" },
    });
  if (path === "/v1/consultations/:id")
    return obj({
      ...consultation.properties,
      prescriptions: {
        type: "array",
        items: obj(
          {
            id: uuid,
            createdAt: date,
            medications: {
              type: "array",
              items: obj({
                name: str(),
                dosage: str(),
                instructions: str(500),
                durationDays: { type: "integer" },
              }),
            },
            notes: str(4000),
          },
          ["id", "createdAt", "medications"],
        ),
      },
    });
  if (path.endsWith("/status")) return obj({ id: uuid, status: str() });
  if (path === "/v1/admin/analytics")
    return list(
      obj({
        day: { type: "string", format: "date" },
        booked: { type: "string" },
        completed: { type: "string" },
        cancelled: { type: "string" },
        refreshed_at: date,
      }),
      false,
    );
  if (path === "/v1/admin/audit")
    return list(
      obj({
        id: uuid,
        actor_id: { ...uuid, nullable: true },
        action: str(),
        resource_id: { ...uuid, nullable: true },
        request_id: str(),
        created_at: date,
      }),
      false,
    );
  return obj({ id: uuid });
}
