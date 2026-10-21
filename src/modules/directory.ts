import { randomUUID } from "node:crypto";
import type { RouteContext } from "../http.js";
import { str, obj, uuid, idParams, page } from "../schema.js";
import { fail } from "../security.js";
import { audit } from "../transactions.js";
export async function registerDirectory(ctx: RouteContext) {
  const { route, role } = ctx;
  route({
    method: "PATCH",
    url: "/v1/admin/users/:id",
    params: idParams,
    summary: "Set user role or suspend account and revoke sessions",
    body: obj({
      role: { type: "string", enum: ["patient", "doctor", "admin"] },
      active: { type: "boolean" },
    }),
    handler: async (req, tx, u) => {
      role(u!, "admin");
      if (req.params.id === u!.id) fail(409, "cannot_change_self");
      const changed = await tx.query(
        "UPDATE users SET role=$2,active=$3 WHERE id=$1 RETURNING id",
        [req.params.id, req.body.role, req.body.active],
      );
      if (!changed.rowCount) fail(404, "not_found");
      await tx.query("DELETE FROM sessions WHERE user_id=$1", [req.params.id]);
      await audit(tx, u!.id, "user.access_changed", req.params.id, req.id);
      return { status: 200, body: { updated: true } };
    },
  });
  route({
    method: "POST",
    url: "/v1/admin/doctors",
    summary: "Verify and publish a doctor directory entry",
    body: obj({
      userId: uuid,
      displayName: str(100),
      specialty: str(80),
      languages: {
        type: "array",
        items: str(30),
        minItems: 1,
        maxItems: 10,
        uniqueItems: true,
      },
      feePaise: { type: "integer", minimum: 0, maximum: 10000000 },
    }),
    handler: async (req, tx, u) => {
      role(u!, "admin");
      const b = req.body;
      const target = (
        await tx.query(
          "SELECT id FROM users WHERE id=$1 AND role='doctor' AND active FOR UPDATE",
          [b.userId],
        )
      ).rows[0];
      if (!target) fail(409, "doctor_role_required");
      await tx.query(
        "INSERT INTO doctors(id,display_name,specialty,languages,fee_paise,verified) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(id) DO UPDATE SET display_name=$2,specialty=$3,languages=$4,fee_paise=$5,verified=true",
        [b.userId, b.displayName, b.specialty, b.languages, b.feePaise],
      );
      await audit(tx, u!.id, "doctor.verified", b.userId, req.id);
      return { status: 201, body: { id: b.userId } };
    },
  });
  route({
    method: "GET",
    url: "/v1/doctors",
    summary: "Filter verified doctors using stable UUID cursor",
    querystring: obj(
      {
        specialty: str(80),
        language: str(30),
        maxFeePaise: { type: "integer", minimum: 0 },
        after: uuid,
        limit: page,
      },
      [],
    ),
    handler: async (req, tx) => {
      const q = req.query;
      const rows = (
        await tx.query(
          `SELECT d.* FROM doctors d JOIN users u ON u.id=d.id WHERE d.verified AND u.active AND u.role='doctor' AND ($1::text IS NULL OR d.specialty=$1) AND ($2::text IS NULL OR $2=ANY(d.languages)) AND ($3::integer IS NULL OR d.fee_paise<=$3) AND ($4::uuid IS NULL OR d.id>$4) ORDER BY d.id LIMIT $5`,
          [
            q.specialty ?? null,
            q.language ?? null,
            q.maxFeePaise ?? null,
            q.after ?? null,
            q.limit,
          ],
        )
      ).rows;
      return {
        status: 200,
        body: {
          items: rows,
          nextCursor: rows.length === q.limit ? rows.at(-1)!.id : null,
        },
      };
    },
  });
  route({
    method: "POST",
    url: "/v1/slots",
    summary: "Publish a nonoverlapping doctor availability slot",
    body: obj({
      startsAt: { type: "string", format: "date-time" },
      endsAt: { type: "string", format: "date-time" },
    }),
    handler: async (req, tx, u) => {
      role(u!, "doctor");
      const start = new Date(req.body.startsAt),
        end = new Date(req.body.endsAt);
      if (
        start.getTime() <= Date.now() ||
        end.getTime() - start.getTime() < 300000 ||
        end.getTime() - start.getTime() > 7200000
      )
        fail(400, "invalid_slot_time");
      const doctor = (
        await tx.query(
          "SELECT * FROM doctors WHERE id=$1 AND verified FOR UPDATE",
          [u!.id],
        )
      ).rows[0];
      if (!doctor) fail(403, "unverified_doctor");
      const overlaps = await tx.query(
        "SELECT id FROM availability_slots WHERE doctor_id=$1 AND starts_at<$3 AND ends_at>$2",
        [u!.id, start, end],
      );
      if (overlaps.rowCount) fail(409, "overlapping_slot");
      const id = randomUUID();
      await tx.query(
        "INSERT INTO availability_slots(id,doctor_id,starts_at,ends_at) VALUES($1,$2,$3,$4)",
        [id, u!.id, start, end],
      );
      await audit(tx, u!.id, "slot.created", id, req.id);
      return { status: 201, body: { id } };
    },
  });
  route({
    method: "GET",
    url: "/v1/doctors/:id/slots",
    params: idParams,
    summary: "List available future slots (booking revalidates)",
    querystring: obj(
      { after: { type: "string", format: "date-time" }, limit: page },
      [],
    ),
    handler: async (req, tx) => {
      const rows = (
        await tx.query(
          `SELECT s.* FROM availability_slots s JOIN users u ON u.id=s.doctor_id WHERE s.doctor_id=$1 AND u.active AND u.role='doctor' AND s.starts_at>greatest(now(),coalesce($2::timestamptz,now())) AND NOT EXISTS(SELECT 1 FROM consultations c WHERE c.slot_id=s.id AND c.status<>'cancelled') ORDER BY s.starts_at LIMIT $3`,
          [req.params.id, req.query.after ?? null, req.query.limit],
        )
      ).rows;
      return {
        status: 200,
        body: {
          items: rows,
          nextCursor:
            rows.length === req.query.limit ? rows.at(-1)!.starts_at : null,
        },
      };
    },
  });
}
