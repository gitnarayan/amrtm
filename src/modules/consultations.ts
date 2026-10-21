import { randomUUID } from "node:crypto";
import type { Db } from "../db.js";
import type { Identity, RouteContext } from "../http.js";
import { str, obj, uuid, idParams, page } from "../schema.js";
import { fail } from "../security.js";
import { audit, event } from "../transactions.js";
export async function registerConsultations(ctx: RouteContext) {
  const { route, db, crypt, role } = ctx;
  route({
    method: "POST",
    url: "/v1/consultations",
    summary: "Atomically book slot, record payment intent and queue analytics",
    body: obj({ slotId: uuid }),
    handler: async (req, tx, u) => {
      role(u!, "patient");
      const slot = (
        await tx.query(
          `SELECT s.*,d.fee_paise FROM availability_slots s JOIN doctors d ON d.id=s.doctor_id JOIN users u ON u.id=d.id WHERE s.id=$1 AND s.starts_at>now() AND d.verified AND u.active AND u.role='doctor' FOR UPDATE OF s`,
          [req.body.slotId],
        )
      ).rows[0];
      if (!slot) fail(404, "slot_not_available");
      const existing = await tx.query(
        "SELECT id FROM consultations WHERE slot_id=$1 AND status<>'cancelled'",
        [slot.id],
      );
      if (existing.rowCount) fail(409, "slot_already_booked");
      const id = randomUUID();
      await tx.query(
        "INSERT INTO consultations(id,patient_id,doctor_id,slot_id,status) VALUES($1,$2,$3,$4,'booked')",
        [id, u!.id, slot.doctor_id, slot.id],
      );
      await tx.query(
        "INSERT INTO payments(id,consultation_id,amount_paise,status) VALUES($1,$2,$3,'not_collected')",
        [randomUUID(), id, slot.fee_paise],
      );
      await audit(tx, u!.id, "consultation.booked", id, req.id);
      await event(tx, "consultation.changed", id);
      return {
        status: 201,
        body: { id, status: "booked", paymentStatus: "not_collected" },
      };
    },
  });
  route({
    method: "GET",
    url: "/v1/consultations",
    summary: "List own consultations",
    querystring: obj({ after: uuid, limit: page }, []),
    handler: async (req, _tx, u) =>
      db.transaction(async (tx) => {
        const rows = (
          await tx.query(
            "SELECT * FROM consultations WHERE (patient_id=$1 OR doctor_id=$1) AND ($2::uuid IS NULL OR id>$2) ORDER BY id LIMIT $3",
            [u!.id, req.query.after ?? null, req.query.limit],
          )
        ).rows;
        await audit(tx, u!.id, "consultation.list", u!.id, req.id);
        return {
          status: 200,
          body: {
            items: rows,
            nextCursor:
              rows.length === req.query.limit ? rows.at(-1)!.id : null,
          },
        };
      }),
  });
  async function consultation(tx: Db, id: string, u: Identity, lock = false) {
    const row = (
      await tx.query(
        `SELECT * FROM consultations WHERE id=$1${lock ? " FOR UPDATE" : ""}`,
        [id],
      )
    ).rows[0];
    if (!row || (row.patient_id !== u.id && row.doctor_id !== u.id))
      return fail(404, "not_found");
    return row;
  }
  route({
    method: "GET",
    url: "/v1/consultations/:id",
    params: idParams,
    summary: "Read own consultation and prescriptions with audit",
    handler: async (req, _tx, u) =>
      db.transaction(async (tx) => {
        const row = await consultation(tx, req.params.id, u!);
        const prescriptions = (
          await tx.query(
            "SELECT * FROM prescriptions WHERE consultation_id=$1",
            [row.id],
          )
        ).rows.map((p) => ({
          id: p.id,
          createdAt: p.created_at,
          ...crypt.decrypt(p.encrypted_data, `prescription:${p.id}`),
        }));
        await audit(tx, u!.id, "consultation.read", row.id, req.id);
        return { status: 200, body: { ...row, prescriptions } };
      }),
  });
  route({
    method: "PATCH",
    url: "/v1/consultations/:id/status",
    params: idParams,
    summary: "Transition booked → in_progress → completed, or cancel booked",
    body: obj({
      status: {
        type: "string",
        enum: ["in_progress", "completed", "cancelled"],
      },
    }),
    handler: async (req, tx, u) => {
      const row = await consultation(tx, req.params.id, u!, true);
      const next = req.body.status;
      if (next === "cancelled") {
        if (row.status !== "booked") fail(409, "invalid_transition");
      } else {
        role(u!, "doctor");
        if (row.doctor_id !== u!.id) fail(403, "forbidden");
        if (!(
          (row.status === "booked" && next === "in_progress") ||
          (row.status === "in_progress" && next === "completed")
        ))
          fail(409, "invalid_transition");
      }
      await tx.query(
        "UPDATE consultations SET status=$2,updated_at=now() WHERE id=$1",
        [row.id, next],
      );
      if (next === "cancelled")
        await tx.query(
          "UPDATE payments SET status='void' WHERE consultation_id=$1",
          [row.id],
        );
      await audit(tx, u!.id, `consultation.${next}`, row.id, req.id);
      await event(tx, "consultation.changed", row.id);
      return { status: 200, body: { id: row.id, status: next } };
    },
  });
  route({
    method: "POST",
    url: "/v1/consultations/:id/prescriptions",
    params: idParams,
    summary: "Issue immutable prescription as assigned doctor",
    body: obj(
      {
        medications: {
          type: "array",
          minItems: 1,
          maxItems: 30,
          items: obj({
            name: str(100),
            dosage: str(100),
            instructions: str(500),
            durationDays: { type: "integer", minimum: 1, maximum: 365 },
          }),
        },
        notes: { type: "string", maxLength: 4000 },
      },
      ["medications"],
    ),
    handler: async (req, tx, u) => {
      role(u!, "doctor");
      const row = await consultation(tx, req.params.id, u!, true);
      if (row.doctor_id !== u!.id) fail(404, "not_found");
      if (row.status !== "in_progress")
        fail(409, "consultation_not_in_progress");
      const id = randomUUID();
      await tx.query(
        "INSERT INTO prescriptions(id,consultation_id,doctor_id,encrypted_data) VALUES($1,$2,$3,$4)",
        [id, row.id, u!.id, crypt.encrypt(req.body, `prescription:${id}`)],
      );
      await audit(tx, u!.id, "prescription.issued", id, req.id);
      return { status: 201, body: { id } };
    },
  });
}
