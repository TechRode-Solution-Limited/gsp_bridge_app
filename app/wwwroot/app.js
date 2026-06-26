const $ = (id) => document.getElementById(id);

// ---- Config / connection ----

function setConnected(connected, message) {
  const status = $("conn-status");
  status.className = "status-dot " + (connected ? "online" : "offline");
  status.textContent = connected ? "connected" : "disconnected";
  $("btn-connect").hidden = connected;
  $("btn-disconnect").hidden = !connected;
  if (message !== undefined) $("conn-msg").textContent = message;
  if (connected) $("device-addr").textContent = `${$("cfg-ip").value}:${$("cfg-port").value}`;
}

async function probeStatus() {
  $("conn-msg").textContent = "Checking device...";
  const { ok, body } = await callJson("/api/v1/status", { ip: $("cfg-ip").value, port: parseInt($("cfg-port").value, 10) });
  if (ok && body.data?.online) setConnected(true, `Online — ${body.data.product || body.data.serial || "device"}`);
  else setConnected(false, ok ? "Device offline" : (body.error || "Status check failed"));
}

async function loadConfig() {
  const r = await fetch("/api/config");
  const j = await r.json();
  const d = j.device;
  $("cfg-ip").value = d.ip;
  $("cfg-port").value = d.port;
  $("cfg-password").value = d.password ?? 0;
  $("cfg-timeout").value = d.timeout ?? 10;
  $("cfg-machine").value = d.machineNumber ?? 1;
  $("device-addr").textContent = `${d.ip}:${d.port}`;
}

function deviceOverrides() {
  return {
    ip: $("cfg-ip").value.trim(),
    port: parseInt($("cfg-port").value, 10),
    password: parseInt($("cfg-password").value, 10) || 0,
    timeout: parseInt($("cfg-timeout").value, 10) || 10,
    machineNumber: parseInt($("cfg-machine").value, 10) || 1,
  };
}

// ---- Tab switching ----

document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    document.querySelectorAll(".tab-pane").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    $("tab-" + tab.dataset.tab).classList.add("active");
  });
});

// ---- Output helpers ----

function show(elId, ok, payload) {
  const el = $(elId);
  el.classList.remove("ok", "err");
  el.classList.add(ok ? "ok" : "err");
  el.textContent = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
}

function showHtml(elId, ok, html) {
  const el = $(elId);
  el.classList.remove("ok", "err");
  el.classList.add(ok ? "ok" : "err");
  el.innerHTML = html;
}

// Coloured freshness indicator for the Cached tab.
//   ok    — served from cache, within TTL
//   stale — served from cache but past TTL / restored-on-restart / busted by a write
//   live  — cache was empty, this value came from a live device read (fallback)
//   miss  — no cached value and no live value available
function freshnessChip(kind) {
  const map = {
    ok:    ["● OK",    "#0f5132", "#d1e7dd"],
    stale: ["● STALE", "#664d03", "#fff3cd"],
    live:  ["● LIVE",  "#084298", "#cfe2ff"],
    miss:  ["● MISS",  "#842029", "#f8d7da"],
  };
  const [label, fg, bg] = map[kind] || map.miss;
  return `<span style="display:inline-block;padding:2px 9px;border-radius:11px;font-size:11px;font-weight:700;letter-spacing:.3px;color:${fg};background:${bg}">${label}</span>`;
}

async function callJson(path, body) {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
  const j = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
  return { ok: res.ok && j.ok !== false, body: j };
}

// ---- Actions ----

const actions = {
  // Connection
  async connect(btn) {
    $("conn-msg").textContent = "Connecting...";
    const { ok, body } = await callJson("/api/connect", deviceOverrides());
    if (ok) setConnected(true, body.message);
    else setConnected(false, body.error || "Connection failed");
  },

  // The Bridge connects per-request, so there's no persistent server session
  // to terminate — Disconnect just resets the UI state.
  async disconnect(btn) {
    setConnected(false, "Disconnected");
  },

  // Users
  async "list-users"(btn) {
    show("out-list-users", true, "Fetching users...");
    const { ok, body } = await callJson("/api/users", deviceOverrides());
    if (!ok) return show("out-list-users", false, body.error || body);

    const rows = body.users.map((u) =>
      `<tr><td>${u.enrollNumber}</td><td>${u.name || ""}</td><td>${u.privilege}</td><td>${u.enabled ? "yes" : "no"}</td></tr>`
    ).join("");

    showHtml("out-list-users", true, `<table>
      <thead><tr><th>Enroll #</th><th>Name</th><th>Privilege</th><th>Enabled</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="4">No users</td></tr>'}</tbody>
    </table><p style="margin:8px 0 0;color:var(--muted)">Total: ${body.count} users</p>`);
  },

  async "list-users-groups"(btn) {
    show("out-list-users", true, "Fetching users + groups...");
    const { ok, body } = await callJson("/api/v1/users/groups", deviceOverrides());
    if (!ok) return show("out-list-users", false, body.error || body);

    const d = body.data;
    const rows = d.users.map((u) =>
      `<tr><td>${u.enrollNumber}</td><td>${u.name || ""}</td><td>${u.privilege}</td><td>${u.enabled ? "yes" : "no"}</td><td>${u.groupNo ?? "-"}</td></tr>`
    ).join("");

    showHtml("out-list-users", true, `<table>
      <thead><tr><th>Enroll #</th><th>Name</th><th>Privilege</th><th>Enabled</th><th>Group</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No users</td></tr>'}</tbody>
    </table><p style="margin:8px 0 0;color:var(--muted)">Total: ${d.count} users</p>`);
  },

  async "get-user"(btn) {
    const enroll = $("get-user-enroll").value.trim();
    if (!enroll) return show("out-get-user", false, "Enter enroll number");
    show("out-get-user", true, "Fetching...");
    const { ok, body } = await callJson("/api/user", { ...deviceOverrides(), enrollNumber: enroll });
    if (!ok) return show("out-get-user", false, body.error || body);
    show("out-get-user", true, body);
  },

  async "create-user"(btn) {
    const enroll = $("create-enroll").value.trim();
    const name = $("create-name").value.trim();
    const privilege = parseInt($("create-privilege").value, 10);
    if (!enroll) return show("out-create-user", false, "Enter enroll number");
    show("out-create-user", true, "Creating...");
    const { ok, body } = await callJson("/api/user/create", { ...deviceOverrides(), enrollNumber: enroll, name, privilege });
    show("out-create-user", ok, ok ? body.message : (body.error || body));
  },

  async "update-user"(btn) {
    const enroll = $("update-enroll").value.trim();
    const name = $("update-name").value.trim();
    const privilege = parseInt($("update-privilege").value, 10);
    if (!enroll) return show("out-update-user", false, "Enter enroll number");
    show("out-update-user", true, "Updating...");
    const { ok, body } = await callJson("/api/user/update", { ...deviceOverrides(), enrollNumber: enroll, name: name || undefined, privilege });
    show("out-update-user", ok, ok ? body.message : (body.error || body));
  },

  async "get-card"(btn) {
    const enroll = $("card-enroll").value.trim();
    if (!enroll) return show("out-card", false, "Enter enroll number");
    show("out-card", true, "Fetching...");
    const { ok, body } = await callJson("/api/v1/users/card/get", { ...deviceOverrides(), enrollNumber: enroll });
    if (!ok) return show("out-card", false, body.error || body);
    const card = body.data.cardNumber || "";
    $("card-number").value = card;
    show("out-card", true, card ? `User ${enroll}: card = ${card}` : `User ${enroll}: no card assigned`);
  },

  async "set-card"(btn) {
    const enroll = $("card-enroll").value.trim();
    const card = $("card-number").value.trim();
    if (!enroll) return show("out-card", false, "Enter enroll number");
    if (!card) return show("out-card", false, "Enter card number (or click Clear to remove)");
    show("out-card", true, "Setting...");
    const { ok, body } = await callJson("/api/v1/users/card/set", { ...deviceOverrides(), enrollNumber: enroll, cardNumber: card });
    show("out-card", ok, ok ? `Card set: ${card}` : (body.error || body));
  },

  async "clear-card"(btn) {
    const enroll = $("card-enroll").value.trim();
    if (!enroll) return show("out-card", false, "Enter enroll number");
    show("out-card", true, "Clearing card...");
    const { ok, body } = await callJson("/api/v1/users/card/set", { ...deviceOverrides(), enrollNumber: enroll, cardNumber: "" });
    if (ok) $("card-number").value = "";
    show("out-card", ok, ok ? "Card cleared" : (body.error || body));
  },

  async "read-card"(btn) {
    const timeout = parseInt($("card-read-timeout").value, 10) || 15;
    show("out-read-card", true, `Waiting for a card tap (up to ${timeout}s)...`);
    const { ok, body } = await callJson("/api/v1/enroll/card", { ...deviceOverrides(), timeoutSeconds: timeout });
    if (!ok) return show("out-read-card", false, body.error || body);
    const card = (body.data && body.data.cardNumber) || "";
    if (card && $("card-number")) $("card-number").value = card;
    show("out-read-card", true, card ? `Card read: ${card} (copied to Card # field)` : "No card captured");
  },

  async "get-password"(btn) {
    const enroll = $("password-enroll").value.trim();
    if (!enroll) return show("out-password", false, "Enter enroll number");
    show("out-password", true, "Fetching...");
    const { ok, body } = await callJson("/api/v1/users/password/get", { ...deviceOverrides(), enrollNumber: enroll });
    if (!ok) return show("out-password", false, body.error || body);
    const pwd = body.data.password || "";
    $("password-value").value = pwd;
    show("out-password", true, pwd ? `User ${enroll}: password = ${pwd}` : `User ${enroll}: no password set`);
  },

  async "set-password"(btn) {
    const enroll = $("password-enroll").value.trim();
    const pwd = $("password-value").value.trim();
    if (!enroll) return show("out-password", false, "Enter enroll number");
    if (!pwd) return show("out-password", false, "Enter password (or click Clear to remove)");
    show("out-password", true, "Setting...");
    const { ok, body } = await callJson("/api/v1/users/password/set", { ...deviceOverrides(), enrollNumber: enroll, password: pwd });
    show("out-password", ok, ok ? "Password updated" : (body.error || body));
  },

  async "clear-password"(btn) {
    const enroll = $("password-enroll").value.trim();
    if (!enroll) return show("out-password", false, "Enter enroll number");
    show("out-password", true, "Clearing password...");
    const { ok, body } = await callJson("/api/v1/users/password/set", { ...deviceOverrides(), enrollNumber: enroll, password: "" });
    if (ok) $("password-value").value = "";
    show("out-password", ok, ok ? "Password cleared" : (body.error || body));
  },

  async "get-validity"(btn) {
    const enroll = $("validity-enroll").value.trim();
    if (!enroll) return show("out-validity", false, "Enter enroll number");
    show("out-validity", true, "Fetching...");
    const { ok, body } = await callJson("/api/user/validity", { ...deviceOverrides(), enrollNumber: enroll });
    if (!ok) return show("out-validity", false, body.error || body);
    const v = body.validity;
    if (v.expires) {
      $("validity-expires").checked = true;
      $("validity-start").value = v.startDate || "";
      $("validity-end").value = v.endDate || "";
    } else {
      $("validity-expires").checked = false;
    }
    show("out-validity", true, v.expires
      ? `User ${v.enrollNumber}: valid from ${v.startDate || "(unset)"} to ${v.endDate || "(unset)"}`
      : `User ${v.enrollNumber}: no expiry set`);
  },

  // TZ Info (slot configuration)
  async "tz-info-get"(btn) {
    const tzIndex = parseInt($("tz-info-index").value, 10);
    if (isNaN(tzIndex)) return show("out-tz-info-get", false, "Enter a TZ index");
    show("out-tz-info-get", true, `Reading TZ slot ${tzIndex}...`);
    const { ok, body } = await callJson("/api/v1/tz/get", { ...deviceOverrides(), tzIndex });
    if (!ok) return show("out-tz-info-get", false, body.error || body);
    const info = body.data.tzInfo;
    $("tz-info-set-index").value = tzIndex;
    $("tz-info-set-data").value = info.tzData || "";
    show("out-tz-info-get", true, `TZ ${tzIndex}: "${info.tzData}"\n(length: ${(info.tzData || "").length} chars — copied to Set fields below)`);
  },

  async "tz-fill-never"(_btn) {
    // 7 days × "00000000" (start 00:00 end 00:00 = no valid window = never)
    $("tz-info-set-data").value = "00000000".repeat(7);
    show("out-tz-info-set", true, `Pre-filled "never" pattern (56 zeros) — click Set TZ data to write it`);
  },

  async "tz-info-set"(btn) {
    const tzIndex = parseInt($("tz-info-set-index").value, 10);
    const tzData = $("tz-info-set-data").value;
    if (isNaN(tzIndex)) return show("out-tz-info-set", false, "Enter a TZ index");
    if (!tzData) return show("out-tz-info-set", false, "Enter TZ data string (or use Fill 'never')");
    show("out-tz-info-set", true, `Writing TZ slot ${tzIndex}...`);
    const { ok, body } = await callJson("/api/v1/tz/set", { ...deviceOverrides(), tzIndex, tzData });
    show("out-tz-info-set", ok, ok ? `TZ ${tzIndex} updated — now assign a user to this slot via the TZs test above` : (body.error || body));
  },

  // User group assignment
  async "user-group-get"(btn) {
    const enroll = $("user-group-enroll").value.trim();
    if (!enroll) return show("out-user-group-get", false, "Enter enroll number");
    show("out-user-group-get", true, "Reading group...");
    const { ok, body } = await callJson("/api/v1/users/group/get", { ...deviceOverrides(), enrollNumber: enroll });
    if (!ok) return show("out-user-group-get", false, body.error || body);
    const ug = body.data.userGroup;
    $("user-group-set-enroll").value = ug.enrollNumber;
    $("user-group-set-no").value = ug.groupNo;
    show("out-user-group-get", true, `User ${ug.enrollNumber} is in group ${ug.groupNo} (copied to Set fields)`);
  },

  async "user-group-set"(btn) {
    const enroll = $("user-group-set-enroll").value.trim();
    const groupNo = parseInt($("user-group-set-no").value, 10);
    if (!enroll) return show("out-user-group-set", false, "Enter enroll number");
    if (isNaN(groupNo)) return show("out-user-group-set", false, "Enter group number");
    show("out-user-group-set", true, `Setting user ${enroll} to group ${groupNo}...`);
    const { ok, body } = await callJson("/api/v1/users/group/set", { ...deviceOverrides(), enrollNumber: enroll, groupNo });
    show("out-user-group-set", ok, ok ? `User ${enroll} → group ${groupNo} — test door access now` : (body.error || body));
  },

  // Group TZ (SSR)
  async "group-tz-get"(btn) {
    const groupNo = parseInt($("group-tz-get-no").value, 10);
    if (isNaN(groupNo)) return show("out-group-tz-get", false, "Enter a group number");
    show("out-group-tz-get", true, `Reading group ${groupNo} TZ...`);
    const { ok, body } = await callJson("/api/v1/groups/tz/get", { ...deviceOverrides(), groupNo });
    if (!ok) return show("out-group-tz-get", false, body.error || body);
    const g = body.data.groupTz;
    $("group-tz-set-no").value = g.groupNo;
    $("group-tz-tz1").value = g.tz1; $("group-tz-tz2").value = g.tz2; $("group-tz-tz3").value = g.tz3;
    $("group-tz-holiday").value = g.validHoliday; $("group-tz-vstyle").value = g.verifyStyle;
    show("out-group-tz-get", true, `Group ${groupNo}: tz1=${g.tz1} tz2=${g.tz2} tz3=${g.tz3} holiday=${g.validHoliday} verifyStyle=${g.verifyStyle} (copied to Set fields)`);
  },

  async "group-tz-set"(btn) {
    const groupNo = parseInt($("group-tz-set-no").value, 10);
    if (isNaN(groupNo)) return show("out-group-tz-set", false, "Enter a group number");
    const tz1 = parseInt($("group-tz-tz1").value, 10) || 0;
    const tz2 = parseInt($("group-tz-tz2").value, 10) || 0;
    const tz3 = parseInt($("group-tz-tz3").value, 10) || 0;
    const validHoliday = parseInt($("group-tz-holiday").value, 10) || 0;
    const verifyStyle = parseInt($("group-tz-vstyle").value, 10) || 0;
    show("out-group-tz-set", true, `Setting group ${groupNo} TZ...`);
    const { ok, body } = await callJson("/api/v1/groups/tz/set", { ...deviceOverrides(), groupNo, tz1, tz2, tz3, validHoliday, verifyStyle });
    show("out-group-tz-set", ok, ok ? `Group ${groupNo} updated` : (body.error || body));
  },

  async "enable-user"(btn) {
    const enroll = $("toggle-enroll").value.trim();
    if (!enroll) return show("out-toggle-user", false, "Enter enroll number");
    show("out-toggle-user", true, "Enabling — assigning group 1 (unrestricted access)...");
    const { ok, body } = await callJson("/api/v1/users/enable", { ...deviceOverrides(), enrollNumber: enroll, enable: true });
    if (!ok) return show("out-toggle-user", false, body.error || body);
    const d = body.data;
    show("out-toggle-user", true, `Enabled — ${d.enrollNumber} → group ${d.groupNo} (${d.method}). Test door access now.`);
  },

  async "disable-user"(btn) {
    const enroll = $("toggle-enroll").value.trim();
    if (!enroll) return show("out-toggle-user", false, "Enter enroll number");
    show("out-toggle-user", true, "Disabling — configuring TZ 20 as 'never', assigning group 2...");
    const { ok, body } = await callJson("/api/v1/users/enable", { ...deviceOverrides(), enrollNumber: enroll, enable: false });
    if (!ok) return show("out-toggle-user", false, body.error || body);
    const d = body.data;
    show("out-toggle-user", true, `Disabled — ${d.enrollNumber} → group ${d.groupNo} (${d.method}). Try authenticating — door should reject.`);
  },

  async "delete-user"(btn) {
    const enroll = $("delete-enroll").value.trim();
    if (!enroll) return show("out-delete-user", false, "Enter enroll number");
    if (!confirm(`Delete user ${enroll}? This removes all enrolled data.`)) return;
    show("out-delete-user", true, "Deleting...");
    const { ok, body } = await callJson("/api/user/delete", { ...deviceOverrides(), enrollNumber: enroll });
    show("out-delete-user", ok, ok ? body.message : (body.error || body));
  },

  async "delete-all-users"(btn) {
    const typed = prompt('This deletes EVERY user and all their enrolled data. Type "DELETE ALL" to confirm.');
    if (typed !== "DELETE ALL") return show("out-delete-all-users", false, "Cancelled — confirmation text did not match.");
    show("out-delete-all-users", true, "Deleting all users...");
    const { ok, body } = await callJson("/api/v1/users/delete-all", deviceOverrides());
    if (!ok) return show("out-delete-all-users", false, body.error || body);
    const d = body.data;
    const msg = `Deleted ${d.deleted}/${d.requested} users${d.failed ? ` — ${d.failed} failed: ${d.errors.join("; ")}` : ""}`;
    show("out-delete-all-users", d.failed === 0, msg);
  },

  // Enrollment
  async "enroll-finger"(btn) {
    const enroll = $("enroll-fp-id").value.trim();
    const finger = parseInt($("enroll-fp-finger").value, 10);
    if (!enroll) return show("out-enroll-finger", false, "Enter enroll number");
    show("out-enroll-finger", true, "Starting enrollment...");
    const { ok, body } = await callJson("/api/enroll/finger", { ...deviceOverrides(), enrollNumber: enroll, fingerIndex: finger });
    show("out-enroll-finger", ok, ok ? body.message : (body.error || body));
  },

  async "enroll-face"(btn) {
    const enroll = $("enroll-face-id").value.trim();
    if (!enroll) return show("out-enroll-face", false, "Enter enroll number");
    show("out-enroll-face", true, "Starting enrollment...");
    const { ok, body } = await callJson("/api/enroll/face", { ...deviceOverrides(), enrollNumber: enroll });
    show("out-enroll-face", ok, ok ? body.message : (body.error || body));
  },

  // Templates
  async "get-finger-tpl"(btn) {
    const enroll = $("tpl-fp-get-enroll").value.trim();
    const finger = parseInt($("tpl-fp-get-finger").value, 10);
    if (!enroll) return show("out-get-finger-tpl", false, "Enter enroll number");
    show("out-get-finger-tpl", true, "Fetching...");
    const { ok, body } = await callJson("/api/template/finger", { ...deviceOverrides(), enrollNumber: enroll, fingerIndex: finger });
    if (!ok) return show("out-get-finger-tpl", false, body.error || body);
    if (!body.found) return show("out-get-finger-tpl", true, `No fingerprint template in slot ${finger} for user ${enroll}`);
    show("out-get-finger-tpl", true, body);
  },

  async "get-face-tpl"(btn) {
    const enroll = $("tpl-face-get-enroll").value.trim();
    const faceIndex = parseInt($("tpl-face-get-index").value, 10) || 50;
    if (!enroll) return show("out-get-face-tpl", false, "Enter enroll number");
    show("out-get-face-tpl", true, "Fetching...");
    const { ok, body } = await callJson("/api/template/face", { ...deviceOverrides(), enrollNumber: enroll, faceIndex });
    if (!ok) return show("out-get-face-tpl", false, body.error || body);
    if (!body.found) return show("out-get-face-tpl", true, `No face template in slot ${faceIndex} for user ${enroll}`);
    show("out-get-face-tpl", true, body);
  },

  async "delete-finger-tpl"(btn) {
    const enroll = $("tpl-fp-del-enroll").value.trim();
    const finger = parseInt($("tpl-fp-del-finger").value, 10);
    if (!enroll) return show("out-delete-finger-tpl", false, "Enter enroll number");
    if (!confirm(`Delete fingerprint template for ${enroll} finger=${finger}?`)) return;
    show("out-delete-finger-tpl", true, "Deleting...");
    const { ok, body } = await callJson("/api/template/finger/delete", { ...deviceOverrides(), enrollNumber: enroll, fingerIndex: finger });
    show("out-delete-finger-tpl", ok, ok ? body.message : (body.error || body));
  },

  async "delete-face-tpl"(btn) {
    const enroll = $("tpl-face-del-enroll").value.trim();
    const faceIndex = parseInt($("tpl-face-del-index").value, 10) || 50;
    if (!enroll) return show("out-delete-face-tpl", false, "Enter enroll number");
    if (!confirm(`Delete face template for ${enroll} face=${faceIndex}?`)) return;
    show("out-delete-face-tpl", true, "Deleting...");
    const { ok, body } = await callJson("/api/template/face/delete", { ...deviceOverrides(), enrollNumber: enroll, faceIndex });
    show("out-delete-face-tpl", ok, ok ? body.message : (body.error || body));
  },

  async "upload-finger-tpl"(btn) {
    const enroll = $("tpl-fp-up-enroll").value.trim();
    const finger = parseInt($("tpl-fp-up-finger").value, 10);
    const template = $("tpl-fp-up-data").value.trim();
    if (!enroll) return show("out-upload-finger-tpl", false, "Enter enroll number");
    if (!template) return show("out-upload-finger-tpl", false, "Paste template data");
    show("out-upload-finger-tpl", true, "Uploading...");
    const { ok, body } = await callJson("/api/template/finger/upload", { ...deviceOverrides(), enrollNumber: enroll, fingerIndex: finger, template });
    show("out-upload-finger-tpl", ok, ok ? body.message : (body.error || body));
  },

  async "upload-face-tpl"(btn) {
    const enroll = $("tpl-face-up-enroll").value.trim();
    const faceIndex = parseInt($("tpl-face-up-index").value, 10) || 50;
    const template = $("tpl-face-up-data").value.trim();
    const bytesRaw = $("tpl-face-up-bytes").value.trim();
    const bytes = bytesRaw ? parseInt(bytesRaw, 10) : undefined;
    if (!enroll) return show("out-upload-face-tpl", false, "Enter enroll number");
    if (!template) return show("out-upload-face-tpl", false, "Paste template data");
    show("out-upload-face-tpl", true, "Uploading...");
    const payload = { ...deviceOverrides(), enrollNumber: enroll, faceIndex, template };
    if (bytes) payload.bytes = bytes;
    const { ok, body } = await callJson("/api/template/face/upload", payload);
    show("out-upload-face-tpl", ok, ok ? body.message : (body.error || body));
  },

  // Attendance
  async "att-all"(btn) {
    show("out-att-all", true, "Fetching all logs...");
    const { ok, body } = await callJson("/api/attendance/all", deviceOverrides());
    if (!ok) return show("out-att-all", false, body.error || body);
    renderAttLogs("out-att-all", body);
  },

  async "att-drain"(btn) {
    if (!confirm("Fetch ALL attendance logs and schedule a background delete of everything read? Newer scans arriving after this call are preserved.")) return;
    show("out-att-drain", true, "Draining...");
    const { ok, body } = await callJson("/api/v1/attendance/all-and-clear", deviceOverrides());
    if (!ok) return show("out-att-drain", false, body.error || body);
    const d = body.data;
    if (!d.logs.length) {
      show("out-att-drain", true, "Device buffer empty — nothing to drain");
      return;
    }
    const rows = d.logs.map(l =>
      `<tr><td>${l.userId}</td><td>${l.timestamp}</td><td>${verifyNames[l.verifyMethod] ?? l.verifyMethod}</td><td>${inOutNames[l.inOutState] ?? l.inOutState}</td><td>${l.workCode || ""}</td></tr>`
    ).join("");
    showHtml("out-att-drain", true, `<table>
      <thead><tr><th>User ID</th><th>Time</th><th>Verify</th><th>State</th><th>Work Code</th></tr></thead>
      <tbody>${rows}</tbody>
    </table><p style="margin:8px 0 0;color:var(--muted)">Returned ${d.count} records. Background bulk clear scheduled.</p>`);
  },

  async "att-new"(btn) {
    show("out-att-new", true, "Fetching new logs...");
    const { ok, body } = await callJson("/api/attendance/new", deviceOverrides());
    if (!ok) return show("out-att-new", false, body.error || body);
    renderAttLogs("out-att-new", body);
  },

  async "att-today"(btn) {
    show("out-att-today", true, "Fetching today's logs...");
    const { ok, body } = await callJson("/api/attendance/today", deviceOverrides());
    if (!ok) return show("out-att-today", false, body.error || body);
    renderAttLogs("out-att-today", body);
  },

  async "att-range"(btn) {
    const startDate = fmtDt($("att-range-start").value);
    const endDate = fmtDt($("att-range-end").value);
    if (!startDate || !endDate) return show("out-att-range", false, "Select start and end dates");
    show("out-att-range", true, "Fetching...");
    const { ok, body } = await callJson("/api/attendance/range", { ...deviceOverrides(), startDate, endDate });
    if (!ok) return show("out-att-range", false, body.error || body);
    renderAttLogs("out-att-range", body);
  },

  async "att-admin"(btn) {
    show("out-att-admin", true, "Fetching admin logs...");
    const { ok, body } = await callJson("/api/attendance/admin", deviceOverrides());
    if (!ok) return show("out-att-admin", false, body.error || body);
    if (!body.logs.length) return show("out-att-admin", true, "No admin logs");
    const rows = body.logs.map(l =>
      `<tr><td>${l.admin}</td><td>${l.target}</td><td>${l.manipulation}</td><td>${l.timestamp}</td></tr>`
    ).join("");
    showHtml("out-att-admin", true, `<table>
      <thead><tr><th>Admin</th><th>Target</th><th>Action</th><th>Time</th></tr></thead>
      <tbody>${rows}</tbody>
    </table><p style="margin:8px 0 0;color:var(--muted)">Total: ${body.count} entries</p>`);
  },

  async "att-delete-range"(btn) {
    const startDate = fmtDt($("att-del-start").value);
    const endDate = fmtDt($("att-del-end").value);
    if (!startDate || !endDate) return show("out-att-delete-range", false, "Select start and end dates");
    if (!confirm(`Delete attendance logs from ${startDate} to ${endDate}?`)) return;
    show("out-att-delete-range", true, "Deleting...");
    const { ok, body } = await callJson("/api/attendance/delete-range", { ...deviceOverrides(), startDate, endDate });
    show("out-att-delete-range", ok, ok ? body.message : (body.error || body));
  },

  async "att-delete-before"(btn) {
    const before = fmtDt($("att-del-before").value);
    if (!before) return show("out-att-delete-before", false, "Select a date");
    if (!confirm(`Delete all attendance logs before ${before}?`)) return;
    show("out-att-delete-before", true, "Deleting...");
    const { ok, body } = await callJson("/api/attendance/delete-before", { ...deviceOverrides(), before });
    show("out-att-delete-before", ok, ok ? body.message : (body.error || body));
  },

  async "att-clear"(btn) {
    if (!confirm("Clear ALL attendance logs? This cannot be undone.")) return;
    show("out-att-clear", true, "Clearing...");
    const { ok, body } = await callJson("/api/attendance/clear", deviceOverrides());
    show("out-att-clear", ok, ok ? body.message : (body.error || body));
  },

  async "att-clear-admin"(btn) {
    if (!confirm("Clear ALL admin logs? This cannot be undone.")) return;
    show("out-att-clear", true, "Clearing...");
    const { ok, body } = await callJson("/api/attendance/clear-admin", deviceOverrides());
    show("out-att-clear", ok, ok ? body.message : (body.error || body));
  },

  // Device
  async "device-info"(btn) {
    show("out-device-info", true, "Fetching...");
    const { ok, body } = await callJson("/api/device/info", deviceOverrides());
    if (!ok) return show("out-device-info", false, body.error || body);
    const i = body.info;
    showHtml("out-device-info", true, `<dl class="info-grid">
      <dt>Serial</dt><dd>${i.serial}</dd>
      <dt>Product</dt><dd>${i.product}</dd>
      <dt>Firmware</dt><dd>${i.firmware}</dd>
      <dt>Platform</dt><dd>${i.platform}</dd>
      <dt>Vendor</dt><dd>${i.vendor}</dd>
      <dt>SDK Version</dt><dd>${i.sdkVersion}</dd>
      <dt>MAC</dt><dd>${i.mac}</dd>
      <dt>Users</dt><dd>${i.userCount} / ${i.userCapacity}</dd>
      <dt>Fingerprints</dt><dd>${i.fingerprintCount} / ${i.fingerprintCapacity}</dd>
      <dt>Faces</dt><dd>${i.faceCount} / ${i.faceCapacity}</dd>
      <dt>Att. Logs</dt><dd>${i.attLogCount} / ${i.attLogCapacity}</dd>
    </dl>`);
  },

  async "device-time"(btn) {
    show("out-device-time", true, "Fetching...");
    const { ok, body } = await callJson("/api/device/time", deviceOverrides());
    show("out-device-time", ok, ok ? `Device time: ${body.time}` : (body.error || body));
  },

  async "device-time-sync"(btn) {
    show("out-device-time", true, "Syncing...");
    const { ok, body } = await callJson("/api/device/time/set", deviceOverrides());
    show("out-device-time", ok, ok ? body.message : (body.error || body));
  },

  async "voice-test"(btn) {
    const index = parseInt($("voice-index").value, 10) || 0;
    show("out-voice-test", true, "Playing...");
    const { ok, body } = await callJson("/api/device/voice", { ...deviceOverrides(), index });
    show("out-voice-test", ok, ok ? body.message : (body.error || body));
  },

  async "device-restart"(btn) {
    if (!confirm("Restart the device?")) return;
    show("out-device-restart", true, "Restarting...");
    const { ok, body } = await callJson("/api/device/restart", deviceOverrides());
    show("out-device-restart", ok, ok ? body.message : (body.error || body));
  },

  async "door-lock"(btn) {
    show("out-door", true, "Locking...");
    const { ok, body } = await callJson("/api/device/door/lock", deviceOverrides());
    show("out-door", ok, ok ? body.message : (body.error || body));
  },

  async "door-unlock"(btn) {
    const seconds = parseInt($("door-seconds").value, 10) || 5;
    show("out-door", true, "Unlocking...");
    const { ok, body } = await callJson("/api/device/door/unlock", { ...deviceOverrides(), seconds });
    show("out-door", ok, ok ? body.message : (body.error || body));
  },

  // Cached — served from the background-maintained stores. When the store has no
  // entry yet (fresh boot, device the poller hasn't reached) these fall back to a
  // live read so the tab always shows real data like the Users tab; the response
  // is labelled "live" vs "cached" so you can see which path answered. The
  // Reception-facing v1 contract is unchanged — the fallback is UI-only.
  async "status-cached"(btn) {
    show("out-status-cached", true, "Reading cached status...");
    const { ok, body } = await callJson("/api/v1/status/cached", deviceOverrides());
    if (!ok) return show("out-status-cached", false, body.error || body);
    let d = body.data, live = false;
    if (d.cached === false) {
      const r = await callJson("/api/v1/status", deviceOverrides());
      if (!r.ok || !r.body.data)
        return showHtml("out-status-cached", false,
          `${freshnessChip("miss")}<p>No cached entry for <code>${d.device}</code> and the live probe failed: ${(r.body && r.body.error) || "unknown error"}.</p>`);
      d = r.body.data; live = true;
    }
    const chip = live ? freshnessChip("live") : freshnessChip(d.stale ? "stale" : "ok");
    showHtml("out-status-cached", true, `<p style="margin:0 0 8px">${chip}</p><table><tbody>
      <tr><th>Device</th><td>${d.device}</td></tr>
      <tr><th>Status</th><td>${d.online ? "online" : "offline"}</td></tr>
      <tr><th>Source</th><td>${live ? "live device read (cache was empty)" : `cache · stale: ${d.stale}`}</td></tr>
      ${live ? "" : `<tr><th>Checked at</th><td>${d.checkedAt} (${d.ageSeconds}s ago)</td></tr>`}
      <tr><th>Serial / firmware</th><td>${d.serial ?? "-"} / ${d.firmware ?? "-"}</td></tr>
      ${live ? "" : `<tr><th>Circuit open</th><td>${d.circuitOpen ?? "-"} (fails: ${d.consecutiveFailures ?? "-"})</td></tr>`}
      ${d.error ? `<tr><th>Error</th><td>${d.error}</td></tr>` : ""}
    </tbody></table>`);
  },

  async "users-cached"(btn) {
    show("out-users-cached", true, "Reading cached user list...");
    const { ok, body } = await callJson("/api/v1/users/cached", deviceOverrides());
    if (!ok) return show("out-users-cached", false, body.error || body);
    let d = body.data, live = false;
    if (d.cached === false) {
      // Cache not warm yet — fall back to the live users+groups read (the
      // background refresh will warm the cache shortly).
      const r = await callJson("/api/v1/users/groups", deviceOverrides());
      if (!r.ok || !r.body.data)
        return showHtml("out-users-cached", false,
          `${freshnessChip("miss")}<p>No cached list for <code>${d.device}</code> and the live read failed: ${(r.body && r.body.error) || "unknown error"}.</p>`);
      d = r.body.data; live = true;
    }
    const chip = live ? freshnessChip("live") : freshnessChip(d.stale ? "stale" : "ok");
    const rows = d.users.map((u) =>
      `<tr><td>${u.enrollNumber}</td><td>${u.name || ""}</td><td>${u.privilege}</td><td>${u.enabled ? "yes" : "no"}</td><td>${u.groupNo ?? "-"}</td></tr>`
    ).join("");
    const meta = live
      ? `Total: ${d.count} · live device read (cache was empty)`
      : `Total: ${d.count} · checked ${d.checkedAt}`;
    showHtml("out-users-cached", true, `<p style="margin:0 0 8px">${chip}</p><table>
      <thead><tr><th>Enroll #</th><th>Name</th><th>Privilege</th><th>Enabled</th><th>Group</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5">No users</td></tr>'}</tbody>
    </table><p style="margin:8px 0 0;color:var(--muted)">${meta}</p>`);
  },

  async "user-cached"(btn) {
    const enroll = $("user-cached-enroll").value.trim();
    if (!enroll) return show("out-user-cached", false, "Enter enroll number");
    show("out-user-cached", true, "Reading cached user...");
    const { ok, body } = await callJson("/api/v1/users/cached/get", { ...deviceOverrides(), enrollNumber: enroll });
    if (!ok) return show("out-user-cached", false, body.error || body);
    let d = body.data, u = d.user, live = false;
    if (!d.cached || d.stale || !d.found) {
      // Cache empty / stale / PIN not in the cached list — fall back to a live read.
      const r = await callJson("/api/v1/users/get", { ...deviceOverrides(), enrollNumber: enroll });
      if (r.ok && r.body.data && r.body.data.user) {
        const lu = r.body.data.user;
        u = { enrollNumber: lu.enrollNumber, name: lu.name, privilege: lu.privilege, enabled: lu.enabled, groupNo: null };
        live = true;
      } else if (!u) {
        return showHtml("out-user-cached", false,
          `${freshnessChip("miss")}<p>User <code>${enroll}</code> not in cache for <code>${d.device}</code>, and the live read failed: ${(r.body && r.body.error) || "unknown error"}.</p>`);
      }
      // else: live read failed but a (stale) cached record exists — show it below.
    }
    const chip = live ? freshnessChip("live") : freshnessChip(d.stale ? "stale" : "ok");
    showHtml("out-user-cached", true, `<p style="margin:0 0 8px">${chip}</p><table><tbody>
      <tr><th>Enroll #</th><td>${u.enrollNumber}</td></tr>
      <tr><th>Name</th><td>${u.name || "-"}</td></tr>
      <tr><th>Privilege</th><td>${u.privilege}</td></tr>
      <tr><th>Enabled</th><td>${u.enabled ? "yes" : "no"}</td></tr>
      <tr><th>Group</th><td>${u.groupNo ?? "-"}</td></tr>
      ${live ? "" : `<tr><th>Checked at</th><td>${d.checkedAt}</td></tr>`}
    </tbody></table>`);
  },

  async "group-cached"(btn) {
    const enroll = $("group-cached-enroll").value.trim();
    if (!enroll) return show("out-group-cached", false, "Enter enroll number");
    show("out-group-cached", true, "Reading cached group...");
    const { ok, body } = await callJson("/api/v1/users/group/cached", { ...deviceOverrides(), enrollNumber: enroll });
    if (!ok) return show("out-group-cached", false, body.error || body);
    const d = body.data;
    if (d.cached && d.userGroup)
      return showHtml("out-group-cached", true,
        `<p style="margin:0 0 8px">${freshnessChip("ok")}</p><p>PIN <code>${d.userGroup.enrollNumber}</code> → group <strong>${d.userGroup.groupNo}</strong></p>`);
    // Cache miss / stale — fall back to the live read like reception would.
    const r = await callJson("/api/v1/users/group/get", { ...deviceOverrides(), enrollNumber: enroll });
    if (r.ok && r.body.data && r.body.data.userGroup) {
      const ug = r.body.data.userGroup;
      return showHtml("out-group-cached", true,
        `<p style="margin:0 0 8px">${freshnessChip("live")}</p><p>PIN <code>${ug.enrollNumber}</code> → group <strong>${ug.groupNo}</strong> <span style="color:var(--muted)">(cache miss/stale — read live)</span></p>`);
    }
    showHtml("out-group-cached", false,
      `${freshnessChip("miss")}<p>Cache miss for <code>${enroll}</code> on <code>${d.device}</code> and the live read failed: ${(r.body && r.body.error) || "unknown error"}.</p>`);
  },
};

// ---- Event delegation ----

document.addEventListener("click", async (e) => {
  const btn = e.target.closest("button[data-action]");
  if (!btn) return;
  const action = btn.dataset.action;
  if (!actions[action]) return;
  btn.disabled = true;
  try { await actions[action](btn); }
  finally { btn.disabled = false; }
});

// Format datetime-local value to "yyyy-MM-dd HH:mm:ss"
function fmtDt(val) {
  if (!val) return null;
  return val.replace("T", " ") + (val.length === 16 ? ":00" : "");
}

const verifyNames = { 0: "Password", 1: "Fingerprint", 2: "Card", 3: "Face", 4: "Multi" };
const inOutNames = { 0: "Check-In", 1: "Check-Out", 2: "Break-Out", 3: "Break-In", 4: "OT-In", 5: "OT-Out" };

function renderAttLogs(elId, body) {
  if (!body.logs.length) return show(elId, true, "No logs found");
  const rows = body.logs.map(l =>
    `<tr><td>${l.userId}</td><td>${l.timestamp}</td><td>${verifyNames[l.verifyMethod] ?? l.verifyMethod}</td><td>${inOutNames[l.inOutState] ?? l.inOutState}</td><td>${l.workCode || ""}</td></tr>`
  ).join("");
  showHtml(elId, true, `<table>
    <thead><tr><th>User ID</th><th>Time</th><th>Verify</th><th>State</th><th>Work Code</th></tr></thead>
    <tbody>${rows}</tbody>
  </table><p style="margin:8px 0 0;color:var(--muted)">Total: ${body.count} records</p>`);
}

loadConfig().then(probeStatus);
