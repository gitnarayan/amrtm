const root = document.querySelector("#app");
const notice = document.querySelector("#notice");
let token = "",
  me = null,
  stage = "login",
  enrollment = null,
  email = "",
  expiry;
let page = "",
  cursor = null,
  selectedDoctor = null,
  viewId = 0;
const pending = new Map();
const esc = (v) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const date = (v) =>
  new Date(v).toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
const money = (v) =>
  new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(v / 100);
const badge = (s) =>
  '<span class="badge ' +
  esc(s) +
  '">' +
  esc(s.replaceAll("_", " ")) +
  "</span>";
const empty = (title, detail) =>
  '<div class="empty"><strong>' +
  esc(title) +
  "</strong>" +
  esc(detail) +
  "</div>";
const field = (name, label, type = "text", value = "", extra = "") =>
  "<label>" +
  esc(label) +
  '<input name="' +
  name +
  '" type="' +
  type +
  '" value="' +
  esc(value) +
  '" ' +
  extra +
  " required></label>";
const button = (label, action, id = "", cls = "secondary") =>
  '<button type="button" class="' +
  cls +
  '" data-action="' +
  action +
  '" data-id="' +
  esc(id) +
  '">' +
  esc(label) +
  "</button>";
let noticeTimer;
function tell(message, error = false) {
  clearTimeout(noticeTimer);
  notice.className = error ? "error" : "";
  notice.textContent = message;
  noticeTimer = setTimeout(() => (notice.textContent = ""), 12000);
}
const errors = {
  invalid_credentials: "Email or password is incorrect.",
  invalid_mfa:
    "The code is incorrect, expired, or already used. Use the next code from this account's authenticator.",
  rate_limited:
    "Too many attempts. Please wait five minutes before trying MFA again.",
  forbidden: "Your account does not have permission for this action.",
  invalid_request: "Please check the required fields and their formats.",
  overlapping_slot: "This availability overlaps a slot you already published.",
  invalid_slot_time:
    "Choose a future slot lasting between 5 minutes and 2 hours.",
  slot_already_booked:
    "Someone has already booked this time. Choose another slot.",
  slot_not_available:
    "This slot is no longer available. Please refresh availability.",
  unverified_doctor:
    "An administrator must verify your doctor profile before you can publish slots.",
  doctor_role_required:
    "Set this user's role to doctor before publishing the directory entry.",
  invalid_transition:
    "The consultation status has changed. Refresh before trying again.",
  not_found: "This record is unavailable or does not belong to your account.",
};
async function api(path, method = "GET", body) {
  const session = token;
  const signature =
    session + "|" + method + "|" + path + "|" + JSON.stringify(body);
  const headers = {};
  if (session) headers.Authorization = "Bearer " + session;
  if (method !== "GET") {
    headers["Content-Type"] = "application/json";
    if (!pending.has(signature)) pending.set(signature, crypto.randomUUID());
    headers["Idempotency-Key"] = pending.get(signature);
  }
  let response;
  try {
    response = await fetch(path, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(20000),
      cache: "no-store",
    });
  } catch {
    throw new Error(
      "Connection interrupted. Retry the same action; its request key is preserved to prevent duplicates.",
    );
  }
  const data = await response.json();
  if (session !== token)
    throw new Error("Your session changed. Please try again.");
  if (response.status < 500) pending.delete(signature);
  if (!response.ok) {
    if (data.error === "unauthorized") {
      reset();
      throw new Error("Your session expired. Sign in and verify MFA again.");
    }
    throw new Error(
      (errors[data.error] ||
        data.error?.replaceAll("_", " ") ||
        "Request failed") +
        (data.requestId ? " (reference " + data.requestId + ")" : ""),
    );
  }
  return data;
}
function reset() {
  clearTimeout(expiry);
  token = "";
  me = null;
  enrollment = null;
  pending.clear();
  stage = "login";
  viewId++;
  renderAuth();
}
function setToken(result) {
  token = result.token;
  clearTimeout(expiry);
  expiry = setTimeout(() => {
    reset();
    tell("Your session expired. Please sign in again.", true);
  }, result.expiresIn * 1000);
}
const brand =
  '<div class="brand"><span class="mark" aria-hidden="true">❧</span> amrutam</div>';
function renderAuth() {
  root.innerHTML =
    '<div class="auth"><section class="story">' +
    brand +
    '<div class="intro"><div class="eyebrow">Rooted in care. Connected to you.</div><h1>A little closer<br>to feeling better.</h1><p>Thoughtful Ayurvedic care, with the right practitioner and a clear path forward.</p><svg class="botanical" viewBox="0 0 220 160" fill="none" aria-hidden="true"><path d="M110 155V35M110 115C35 110 25 60 25 40c65 0 85 35 85 75ZM110 85c70-5 85-50 85-70-60 0-85 30-85 70ZM110 55C70 30 85 5 100 2c25 15 30 33 10 53Z" stroke="currentColor" stroke-width="2"/></svg></div><footer>Personal care · Secure access · Continuity that matters</footer></section><main class="auth-side"><section class="auth-card" aria-label="Account access">' +
    authContent() +
    "</section></main></div>";
}
function authContent() {
  if (stage === "mfa")
    return (
      '<div class="eyebrow">Secure your care</div><h2>' +
      (enrollment ? "Set up your authenticator" : "One more step") +
      '</h2><p class="muted">' +
      esc(email) +
      "</p>" +
      (enrollment
        ? '<p>Add an account in Google Authenticator or another TOTP app. Choose <strong>Enter a setup key</strong> and <strong>Time based</strong>.</p><p class="secret">' +
          esc(enrollment.secret) +
          '</p><p class="hint">Keep this key private. Use a separate authenticator entry for each account.</p>'
        : '<p class="muted">Enter the current six-digit code from the authenticator entry for this account.</p>') +
      '<form data-form="mfa">' +
      field(
        "code",
        "Authenticator code",
        "text",
        "",
        'inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="one-time-code"',
      ) +
      '<button type="submit">Verify & continue →</button></form><div class="actions">' +
      button("Back to sign in", "reset") +
      "</div>"
    );
  return (
    '<div class="eyebrow">Your care starts here</div><h2>' +
    (stage === "register" ? "Create your account" : "Welcome back") +
    '</h2><p class="muted">A secure space for your health and your care team.</p><div class="tabs">' +
    button("Sign in", "login", "", stage === "login" ? "active" : "") +
    button(
      "Create account",
      "register",
      "",
      stage === "register" ? "active" : "",
    ) +
    '</div><form data-form="' +
    stage +
    '">' +
    (stage === "register"
      ? field(
          "name",
          "Full name",
          "text",
          "",
          'maxlength="100" autocomplete="name"',
        )
      : "") +
    field(
      "email",
      "Email address",
      "email",
      email,
      'autocomplete="username" maxlength="254"',
    ) +
    field(
      "password",
      "Password",
      "password",
      "",
      'minlength="15" maxlength="128" autocomplete="' +
        (stage === "register" ? "new-password" : "current-password") +
        '"',
    ) +
    (stage === "register"
      ? '<label class="check"><input type="checkbox" required> <span>I agree to create a care account and record my consent (version 2026-01). This demonstration is not an emergency service.</span></label>'
      : "") +
    '<button type="submit">' +
    (stage === "register" ? "Create account" : "Sign in securely") +
    ' →</button></form><p class="hint">Two-step verification protects every account. Have your authenticator ready. New accounts begin as patients.</p>'
  );
}
function shell() {
  const nav =
    me.role === "admin"
      ? [
          ["analytics", "Overview"],
          ["directory", "Care directory"],
          ["users", "Manage access"],
          ["audit", "Audit trail"],
          ["profile", "My profile"],
        ]
      : me.role === "doctor"
        ? [
            ["consultations", "Consultations"],
            ["availability", "My availability"],
            ["directory", "Care directory"],
            ["profile", "My profile"],
          ]
        : [
            ["directory", "Find a doctor"],
            ["consultations", "My consultations"],
            ["profile", "My profile"],
          ];
  root.innerHTML =
    '<div class="shell"><aside class="sidebar">' +
    brand +
    '<div><p class="eyebrow">Your care space</p><nav class="nav" aria-label="Main navigation">' +
    nav
      .map(([id, label]) =>
        button(label, "nav", id, page === id ? "active" : ""),
      )
      .join("") +
    '</nav></div><div class="sidebar-bottom"><strong>Care, with confidence.</strong><br>Your account is protected with two-step verification.</div></aside><div class="main"><header class="topbar"><small>AMRUTAM / CARE PORTAL</small><div class="account"><span class="avatar">' +
    esc((me.profile?.name || "A").slice(0, 1)) +
    "</span><div><strong>" +
    esc(me.profile?.name || "Your account") +
    "</strong><small>" +
    esc(me.role) +
    "</small></div></div>" +
    button("Sign out", "logout") +
    '</header><main class="content" id="content"><div class="loading">Loading your care space…</div></main></div></div>';
}
const heading = (title, description) =>
  '<div class="page-head"><div><h1>' +
  title +
  "</h1><p>" +
  description +
  "</p></div></div>";
async function navigate(next) {
  notice.textContent = "";
  page = next;
  cursor = null;
  selectedDoctor = null;
  shell();
  const generation = ++viewId;
  try {
    const html = await renderPage();
    if (generation === viewId)
      document.querySelector("#content").innerHTML = html;
  } catch (e) {
    if (generation === viewId && me)
      document.querySelector("#content").innerHTML =
        empty("Could not load this page", e.message) +
        '<div class="actions">' +
        button("Try again", "nav", page) +
        "</div>";
    tell(e.message, true);
  }
}
async function renderPage() {
  if (page === "directory")
    return (
      heading(
        "Find your kind of care",
        "Connect with a verified practitioner, at a time that works for you.",
      ) +
      '<section class="hero"><div><div class="eyebrow">A more personal path to wellness</div><h2>Good care begins with<br>a conversation.</h2><p>Explore practitioners and find your next appointment.</p></div><div class="seal" aria-hidden="true">❧</div></section><form class="panel row" data-form="search"><label>Specialty<input name="specialty" placeholder="e.g. Ayurveda" maxlength="80"></label><label>Language<input name="language" placeholder="e.g. English" maxlength="30"></label><label>Maximum fee (₹)<input name="maxFee" type="number" min="0" step="1" placeholder="Any fee"></label><button type="submit">Find doctors</button></form><div id="doctors">' +
      (await doctors()) +
      "</div>"
    );
  if (page === "consultations")
    return (
      heading(
        "Your consultations",
        me.role === "doctor"
          ? "Your appointments, clinical notes, and next steps."
          : "Keep every step of your care in one place.",
      ) +
      '<div id="consultations">' +
      (await consultations()) +
      "</div>"
    );
  if (page === "availability")
    return (
      heading(
        "Make time for care",
        "Publish appointment slots for patients to book.",
      ) +
      '<form class="panel" data-form="slot"><h2>Add availability</h2><p class="muted">Times use your local timezone. Slots can last 5 minutes to 2 hours.</p><div class="row">' +
      field("startsAt", "Starts at", "datetime-local") +
      field("endsAt", "Ends at", "datetime-local") +
      '<button type="submit">Publish slot</button></div></form><section class="panel"><h2>Available appointments</h2><div id="slots">' +
      (await slotList(me.id)) +
      "</div></section>"
    );
  if (page === "profile")
    return (
      heading("My profile", "Keep your details up to date.") +
      '<section class="panel"><p class="eyebrow">Account ID</p><p class="mono">' +
      esc(me.id) +
      "</p><p>Account type: " +
      badge(me.role) +
      '</p><form data-form="profile">' +
      field(
        "name",
        "Full name",
        "text",
        me.profile?.name || "",
        'maxlength="100"',
      ) +
      '<label>Phone number (optional)<input name="phone" type="tel" pattern="[+]?[0-9]{8,15}" value="' +
      esc(me.profile?.phone || "") +
      '"></label><button type="submit">Save profile</button></form></section>'
    );
  if (page === "users")
    return (
      heading(
        "Manage care access",
        "Assign account access and publish verified practitioners.",
      ) +
      '<div class="grid"><form class="panel" data-form="access"><h2>Account access</h2><p class="muted">Use the account ID from the user’s profile. Changes sign that user out.</p>' +
      field("id", "User ID", "text", "", 'pattern="[0-9a-fA-F-]{36}"') +
      '<label>Role<select name="role"><option value="patient">Patient</option><option value="doctor">Doctor</option><option value="admin">Admin</option></select></label><label>Status<select name="active"><option value="true">Active</option><option value="false">Suspended</option></select></label><button type="submit">Update access</button></form><form class="panel" data-form="doctor"><h2>Publish doctor profile</h2><p class="muted">Assign the doctor role first, then verify the practitioner’s credentials before publishing.</p>' +
      field(
        "userId",
        "Doctor user ID",
        "text",
        "",
        'pattern="[0-9a-fA-F-]{36}"',
      ) +
      field("displayName", "Display name", "text", "", 'maxlength="100"') +
      field("specialty", "Specialty", "text", "", 'maxlength="80"') +
      field("languages", "Languages (comma separated)", "text", "English") +
      field(
        "fee",
        "Consultation fee (₹)",
        "number",
        "",
        'min="0" max="100000" step="0.01"',
      ) +
      '<label class="check"><input type="checkbox" required><span>I have verified this practitioner’s credentials.</span></label><button type="submit">Verify & publish</button></form></div>'
    );
  if (page === "analytics") {
    const today = new Date().toISOString().slice(0, 10);
    return (
      heading(
        "Care at a glance",
        "An overview of consultations across your care network.",
      ) +
      '<form class="panel row" data-form="analytics">' +
      field("from", "From", "date", today) +
      field("to", "To", "date", today) +
      '<button type="submit">View report</button></form><div id="analytics">' +
      (await analytics(today, today)) +
      "</div>"
    );
  }
  if (page === "audit")
    return (
      heading(
        "Audit trail",
        "Account and care activity, without clinical content.",
      ) +
      '<form class="panel row" data-form="audit"><label>Activity after (local time)<input type="datetime-local" name="after"></label><label>Maximum records<select name="limit"><option>25</option><option>50</option><option>100</option></select></label><button type="submit">View activity</button></form><div id="audit">' +
      (await auditRows("")) +
      "</div>"
    );
}
let searchQuery = "";
async function doctors(after = "") {
  const data = await api(
    "/v1/doctors?limit=12" +
      searchQuery +
      (after ? "&after=" + encodeURIComponent(after) : ""),
  );
  cursor = data.nextCursor;
  return (
    (data.items.length
      ? '<div class="grid">' +
        data.items
          .map(
            (d) =>
              '<article class="card"><div class="doctor-head"><span class="avatar">' +
              esc(
                d.display_name
                  .replace(/^Dr[ .]*/i, "")
                  .slice(0, 2)
                  .toUpperCase(),
              ) +
              "</span><div><h3>" +
              esc(d.display_name) +
              "</h3>" +
              badge("verified") +
              "</div></div><p>" +
              esc(d.specialty) +
              '</p><p class="meta">' +
              esc(d.languages.join(" · ")) +
              '</p><div class="card-foot"><div class="fee">' +
              money(d.fee_paise) +
              "<small>per consultation</small></div>" +
              button("View times", "doctor", d.id, "") +
              "</div></article>",
          )
          .join("") +
        "</div>"
      : empty(
          "No matching doctors",
          "Try different filters, or ask your administrator to publish a verified practitioner.",
        )) +
    (cursor
      ? '<div class="actions">' +
        button("Next doctors", "more-doctors", cursor) +
        "</div>"
      : "")
  );
}
async function slotList(id, after = "") {
  const data = await api(
    "/v1/doctors/" +
      encodeURIComponent(id) +
      "/slots?limit=25" +
      (after ? "&after=" + encodeURIComponent(after) : ""),
  );
  return (
    (data.items.length
      ? data.items
          .map(
            (s) =>
              '<div class="slot"><div><strong>' +
              esc(date(s.starts_at)) +
              "</strong><br><small>Until " +
              esc(date(s.ends_at)) +
              "</small></div>" +
              (me.role === "patient"
                ? button("Book appointment", "book", s.id, "")
                : badge("available")) +
              "</div>",
          )
          .join("")
      : empty(
          "No available times",
          "New appointments will appear when this doctor publishes availability.",
        )) +
    (data.nextCursor
      ? '<div class="actions">' +
        button("Next times", "more-slots", data.nextCursor) +
        "</div>"
      : "")
  );
}
async function consultations(after = "") {
  const data = await api(
    "/v1/consultations?limit=25" +
      (after ? "&after=" + encodeURIComponent(after) : ""),
  );
  return (
    (data.items.length
      ? '<section class="panel table-wrap"><table><thead><tr><th>Consultation</th><th>Booked on</th><th>Status</th><th>Details</th></tr></thead><tbody>' +
        data.items
          .map(
            (c) =>
              '<tr><td class="mono">' +
              esc(c.id) +
              "</td><td>" +
              esc(date(c.created_at)) +
              "</td><td>" +
              badge(c.status) +
              "</td><td>" +
              button("Open", "consultation", c.id) +
              "</td></tr>",
          )
          .join("") +
        "</tbody></table></section>"
      : empty(
          "No consultations yet",
          me.role === "patient"
            ? "Find a doctor and book your first appointment."
            : "Booked appointments will appear here.",
        )) +
    (data.nextCursor
      ? '<div class="actions">' +
        button("Next consultations", "more-consultations", data.nextCursor) +
        "</div>"
      : "")
  );
}
async function detail(id) {
  const c = await api("/v1/consultations/" + encodeURIComponent(id));
  let html =
    button("← All consultations", "nav", "consultations", "secondary back") +
    heading("Consultation details", "Your care record and next steps.") +
    '<section class="panel"><div class="row"><div><p class="eyebrow">Consultation ID</p><p class="mono">' +
    esc(c.id) +
    "</p></div>" +
    badge(c.status) +
    "</div><small>Created " +
    esc(date(c.created_at)) +
    " · Updated " +
    esc(date(c.updated_at)) +
    '</small><div class="actions">';
  if (c.status === "booked") {
    if (me.role === "doctor")
      html += button("Start consultation", "status", c.id + "|in_progress", "");
    html += button(
      "Cancel appointment",
      "status",
      c.id + "|cancelled",
      "danger",
    );
  }
  if (c.status === "in_progress" && me.role === "doctor")
    html += button("Complete consultation", "status", c.id + "|completed", "");
  html +=
    '</div></section><section class="panel"><h2>Prescriptions</h2>' +
    (c.prescriptions.length
      ? c.prescriptions
          .map(
            (p) =>
              '<article class="medication"><p class="eyebrow">Issued ' +
              esc(date(p.createdAt)) +
              "</p>" +
              p.medications
                .map(
                  (m) =>
                    "<p><strong>" +
                    esc(m.name) +
                    "</strong> · " +
                    esc(m.dosage) +
                    "<br>" +
                    esc(m.instructions) +
                    "<br><small>" +
                    esc(m.durationDays) +
                    " days</small></p>",
                )
                .join("") +
              "<p>" +
              esc(p.notes) +
              "</p></article>",
          )
          .join("")
      : empty(
          "No prescription issued",
          "Prescriptions will appear here after your doctor issues them.",
        )) +
    "</section>";
  if (me.role === "doctor" && c.status === "in_progress")
    html +=
      '<form class="panel" data-form="prescription" data-id="' +
      esc(id) +
      '"><h2>Issue a prescription</h2><p class="muted">Review carefully. Issued prescriptions cannot be edited.</p><div id="medications">' +
      medicationFields() +
      "</div>" +
      button("+ Add medication", "add-medication") +
      '<label>Clinical notes<textarea name="notes" maxlength="4000"></textarea></label><button type="submit">Issue prescription</button></form>';
  document.querySelector("#content").innerHTML = html;
}
function medicationFields() {
  return (
    '<fieldset class="medication"><legend>Medication</legend><div class="row">' +
    field("medicine", "Name", "text", "", 'maxlength="100"') +
    field("dosage", "Dosage", "text", "", 'maxlength="100"') +
    '</div><div class="row">' +
    field("instructions", "Instructions", "text", "", 'maxlength="500"') +
    field("duration", "Duration (days)", "number", "", 'min="1" max="365"') +
    "</div>" +
    button("Remove", "remove-medication", "", "danger") +
    "</fieldset>"
  );
}
async function analytics(from, to) {
  const d = await api(
    "/v1/admin/analytics?" + new URLSearchParams({ from, to }),
  );
  if (!d.items.length)
    return empty(
      "No report for these dates",
      "Analytics update asynchronously. Check the date range and ensure the worker is running.",
    );
  const sum = (k) => d.items.reduce((s, r) => s + Number(r[k]), 0);
  return (
    '<div class="stats">' +
    ["booked", "completed", "cancelled"]
      .map(
        (k) =>
          '<div class="stat"><span class="muted">' +
          esc(k[0].toUpperCase() + k.slice(1)) +
          "</span><strong>" +
          sum(k) +
          "</strong></div>",
      )
      .join("") +
    '</div><section class="panel table-wrap"><h2>Daily activity</h2><p class="muted">Counts reflect current consultation status, grouped by booking day (UTC).</p><table><thead><tr><th>Day (UTC)</th><th>Booked</th><th>Completed</th><th>Cancelled</th><th>Last refreshed</th></tr></thead><tbody>' +
    d.items
      .map(
        (r) =>
          "<tr><td>" +
          esc(r.day) +
          "</td><td>" +
          esc(r.booked) +
          "</td><td>" +
          esc(r.completed) +
          "</td><td>" +
          esc(r.cancelled) +
          "</td><td>" +
          esc(date(r.refreshed_at)) +
          "</td></tr>",
      )
      .join("") +
    "</tbody></table></section>"
  );
}
async function auditRows(query) {
  const d = await api("/v1/admin/audit?" + (query || "limit=25"));
  return d.items.length
    ? '<section class="panel table-wrap"><h2>Recent activity</h2><p class="muted">Bounded results; narrow the start time to inspect later activity.</p><table><thead><tr><th>Time</th><th>Action</th><th>Actor</th><th>Resource</th></tr></thead><tbody>' +
        d.items
          .map(
            (r) =>
              "<tr><td>" +
              esc(date(r.created_at)) +
              "</td><td>" +
              esc(r.action) +
              '</td><td class="mono">' +
              esc(r.actor_id || "System") +
              '</td><td class="mono">' +
              esc(r.resource_id || "—") +
              "</td></tr>",
          )
          .join("") +
        "</tbody></table></section>"
    : empty("No activity found", "Try a different starting time.");
}
root.addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.target;
  const data = Object.fromEntries(new FormData(form));
  const submit = form.querySelector('[type="submit"]');
  if (submit.disabled) return;
  submit.disabled = true;
  try {
    switch (form.dataset.form) {
      case "login":
      case "register": {
        email = data.email;
        const body = { email: data.email, password: data.password };
        if (form.dataset.form === "register")
          Object.assign(body, { name: data.name, consentVersion: "2026-01" });
        const result = await api("/v1/auth/" + form.dataset.form, "POST", body);
        setToken(result);
        stage = "mfa";
        enrollment = null;
        if (result.kind === "enroll")
          enrollment = await api("/v1/auth/mfa/enroll", "POST", {});
        renderAuth();
        break;
      }
      case "mfa": {
        const r = await api("/v1/auth/mfa/verify", "POST", { code: data.code });
        setToken(r);
        enrollment = null;
        me = await api("/v1/me");
        pending.clear();
        searchQuery = "";
        await navigate(
          me.role === "admin"
            ? "analytics"
            : me.role === "doctor"
              ? "consultations"
              : "directory",
        );
        break;
      }
      case "search": {
        const q = new URLSearchParams();
        if (data.specialty.trim()) q.set("specialty", data.specialty.trim());
        if (data.language.trim()) q.set("language", data.language.trim());
        if (data.maxFee !== "")
          q.set("maxFeePaise", String(Math.round(Number(data.maxFee) * 100)));
        searchQuery = "&" + q;
        document.querySelector("#doctors").innerHTML = await doctors();
        break;
      }
      case "profile": {
        const body = { name: data.name };
        if (data.phone) body.phone = data.phone;
        await api("/v1/me", "PATCH", body);
        me = await api("/v1/me");
        await navigate("profile");
        tell("Profile updated.");
        break;
      }
      case "slot": {
        const startsAt = new Date(data.startsAt),
          endsAt = new Date(data.endsAt);
        if (
          startsAt <= new Date() ||
          endsAt - startsAt < 300000 ||
          endsAt - startsAt > 7200000
        )
          throw new Error(errors.invalid_slot_time);
        await api("/v1/slots", "POST", {
          startsAt: startsAt.toISOString(),
          endsAt: endsAt.toISOString(),
        });
        await navigate("availability");
        tell("Availability published.");
        break;
      }
      case "access": {
        if (
          !confirm("Change this account's role/status and revoke its sessions?")
        )
          break;
        await api("/v1/admin/users/" + encodeURIComponent(data.id), "PATCH", {
          role: data.role,
          active: data.active === "true",
        });
        tell("Account access updated. The user must sign in again.");
        break;
      }
      case "doctor": {
        await api("/v1/admin/doctors", "POST", {
          userId: data.userId,
          displayName: data.displayName,
          specialty: data.specialty,
          languages: [
            ...new Set(
              data.languages
                .split(",")
                .map((s) => s.trim())
                .filter(Boolean),
            ),
          ],
          feePaise: Math.round(Number(data.fee) * 100),
        });
        tell("Verified doctor profile published.");
        break;
      }
      case "analytics": {
        document.querySelector("#analytics").innerHTML = await analytics(
          data.from,
          data.to,
        );
        break;
      }
      case "audit": {
        const q = new URLSearchParams({ limit: data.limit });
        if (data.after) q.set("after", new Date(data.after).toISOString());
        document.querySelector("#audit").innerHTML = await auditRows(
          q.toString(),
        );
        break;
      }
      case "prescription": {
        const medications = [...form.querySelectorAll("fieldset")].map(
          (el) => ({
            name: el.querySelector('[name="medicine"]').value,
            dosage: el.querySelector('[name="dosage"]').value,
            instructions: el.querySelector('[name="instructions"]').value,
            durationDays: Number(el.querySelector('[name="duration"]').value),
          }),
        );
        if (!medications.length)
          throw new Error("Add at least one medication.");
        if (
          !confirm(
            "Issue this prescription? It cannot be edited after issuing.",
          )
        )
          break;
        await api(
          "/v1/consultations/" +
            encodeURIComponent(form.dataset.id) +
            "/prescriptions",
          "POST",
          { medications, notes: data.notes },
        );
        await detail(form.dataset.id);
        tell("Prescription issued.");
        break;
      }
    }
  } catch (e) {
    tell(e.message, true);
  } finally {
    submit.disabled = false;
  }
});
root.addEventListener("click", async (event) => {
  const el = event.target.closest("[data-action]");
  if (!el || el.disabled) return;
  const action = el.dataset.action,
    id = el.dataset.id;
  el.disabled = true;
  try {
    switch (action) {
      case "login":
      case "register":
        stage = action;
        renderAuth();
        break;
      case "reset":
        reset();
        break;
      case "logout":
        await api("/v1/auth/logout", "POST", {});
        reset();
        tell("Signed out of all sessions.");
        break;
      case "nav":
        searchQuery = "";
        await navigate(id);
        break;
      case "more-doctors":
        document.querySelector("#doctors").innerHTML = await doctors(id);
        break;
      case "more-consultations":
        document.querySelector("#consultations").innerHTML =
          await consultations(id);
        break;
      case "doctor":
        selectedDoctor = id;
        document.querySelector("#content").innerHTML =
          button("← Find a doctor", "nav", "directory", "secondary back") +
          heading(
            "Choose your appointment",
            "Times are shown in your local timezone.",
          ) +
          '<section class="panel"><div id="slots">' +
          (await slotList(id)) +
          "</div></section>";
        break;
      case "more-slots":
        document.querySelector("#slots").innerHTML = await slotList(
          selectedDoctor || me.id,
          id,
        );
        break;
      case "book":
        if (
          confirm(
            "Confirm this appointment? Payment is not collected through this portal.",
          )
        ) {
          const r = await api("/v1/consultations", "POST", { slotId: id });
          page = "consultations";
          shell();
          await detail(r.id);
          tell("Appointment booked. Payment has not been collected.");
        }
        break;
      case "consultation":
        await detail(id);
        break;
      case "status": {
        const [cid, status] = id.split("|");
        if (
          !confirm(
            "Set this consultation to " + status.replaceAll("_", " ") + "?",
          )
        )
          break;
        await api(
          "/v1/consultations/" + encodeURIComponent(cid) + "/status",
          "PATCH",
          { status },
        );
        await detail(cid);
        tell("Consultation updated.");
        break;
      }
      case "add-medication":
        if (document.querySelectorAll("#medications fieldset").length >= 30)
          throw new Error("A prescription can contain up to 30 medications.");
        document
          .querySelector("#medications")
          .insertAdjacentHTML("beforeend", medicationFields());
        break;
      case "remove-medication":
        if (document.querySelectorAll("#medications fieldset").length === 1)
          throw new Error("Keep at least one medication.");
        el.closest("fieldset").remove();
        break;
    }
  } catch (e) {
    tell(e.message, true);
  } finally {
    el.disabled = false;
  }
});
renderAuth();
