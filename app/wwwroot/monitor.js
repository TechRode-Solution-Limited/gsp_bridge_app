// GymSync Pro · ZKT Bridge — monitoring page.
// Password-gated (token) dashboard: in-flight device operations + elapsed time,
// recent operation history, live log tail, and active timeouts. All data comes from
// /api/monitor/* (see MonitorApi.cs); the token lives in sessionStorage and is sent
// in the X-Monitor-Token header. A 401 drops back to the login screen.
(() => {
  "use strict";

  const TOKEN_KEY = "zkt-monitor-token";
  const $ = (id) => document.getElementById(id);

  let opsTimer = null, logsTimer = null, clockTimer = null, cacheTimer = null;
  let logLastSeq = 0;
  let logPaused = false;

  // ---- token ----
  const getToken = () => sessionStorage.getItem(TOKEN_KEY);
  const setToken = (t) => sessionStorage.setItem(TOKEN_KEY, t);
  const clearToken = () => sessionStorage.removeItem(TOKEN_KEY);

  // ---- api ----
  async function api(path) {
    const token = getToken();
    const res = await fetch(path, {
      headers: token ? { "X-Monitor-Token": token } : {},
    });
    if (res.status === 401) {
      handleUnauthorized();
      throw new Error("unauthorized");
    }
    const json = await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }));
    if (!json.ok) throw new Error(json.error || `HTTP ${res.status}`);
    return json.data;
  }

  function handleUnauthorized() {
    clearToken();
    stopPolling();
    showLogin("Session expired — please log in again.");
  }

  // ---- views ----
  function showLogin(msg) {
    $("login").hidden = false;
    $("dashboard").hidden = true;
    const err = $("login-error");
    if (msg) { err.textContent = msg; err.hidden = false; } else { err.hidden = true; }
    const pw = $("login-password");
    pw.value = "";
    pw.focus();
  }

  function showDashboard() {
    $("login").hidden = true;
    $("dashboard").hidden = false;
  }

  // ---- login / logout ----
  $("login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const password = $("login-password").value;
    try {
      const res = await fetch("/api/monitor/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password }),
      });
      const json = await res.json().catch(() => ({ ok: false }));
      if (!res.ok || !json.ok) {
        showLogin(json.error || "Invalid password");
        return;
      }
      setToken(json.data.token);
      start();
    } catch {
      showLogin("Could not reach the Bridge.");
    }
  });

  $("btn-logout").addEventListener("click", () => {
    clearToken();
    stopPolling();
    showLogin();
  });

  $("log-pause").addEventListener("change", (e) => { logPaused = e.target.checked; });
  $("log-clear").addEventListener("click", () => { $("log-pane").innerHTML = ""; });

  // ---- start / stop ----
  function start() {
    showDashboard();
    logLastSeq = 0;
    $("log-pane").innerHTML = "";
    loadInfo();
    pollOps();
    pollLogs();
    pollCaches();
    opsTimer = setInterval(pollOps, 1000);
    logsTimer = setInterval(pollLogs, 1500);
    cacheTimer = setInterval(pollCaches, 3000);
    clockTimer = setInterval(() => {
      $("hdr-clock").textContent = new Date().toLocaleTimeString();
    }, 1000);
  }

  function stopPolling() {
    clearInterval(opsTimer); clearInterval(logsTimer); clearInterval(clockTimer); clearInterval(cacheTimer);
    opsTimer = logsTimer = clockTimer = cacheTimer = null;
  }

  // ---- formatters ----
  function fmtDuration(ms) {
    if (ms == null) return "-";
    if (ms < 1000) return `${ms} ms`;
    const s = ms / 1000;
    if (s < 60) return `${s.toFixed(1)} s`;
    const m = Math.floor(s / 60);
    const rem = Math.round(s % 60);
    return `${m}m ${String(rem).padStart(2, "0")}s`;
  }

  function fmtUptime(sec) {
    if (sec == null) return "-";
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (d) return `${d}d ${h}h ${m}m`;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
  }

  function timeAgo(iso) {
    const diff = Math.max(0, Date.now() - new Date(iso).getTime()) / 1000;
    if (diff < 60) return `${Math.floor(diff)}s ago`;
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return new Date(iso).toLocaleTimeString();
  }

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"]/g, (c) => (
      { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]
    ));
  }

  // ---- polls ----
  async function pollOps() {
    let data;
    try { data = await api("/api/monitor/operations"); } catch { return; }

    $("active-count").textContent = data.activeCount;
    const lock = $("hdr-lock");
    lock.className = "status-dot " + (data.deviceLockHeld ? "held" : "free");
    lock.textContent = data.deviceLockHeld ? "held" : "free";

    const aBody = $("active-rows");
    if (!data.active.length) {
      aBody.innerHTML = `<tr class="empty"><td colspan="4">Idle — no operations running.</td></tr>`;
    } else {
      aBody.innerHTML = data.active.map((o) => `
        <tr>
          <td class="mono">${esc(o.label)}</td>
          <td><span class="tag ${esc(o.kind)}">${esc(o.kind)}</span></td>
          <td class="mono">${esc(o.deviceKey || "-")}</td>
          <td class="num">${fmtDuration(o.elapsedMs)}</td>
        </tr>`).join("");
    }

    const rBody = $("recent-rows");
    if (!data.recent.length) {
      rBody.innerHTML = `<tr class="empty"><td colspan="6">No operations yet.</td></tr>`;
    } else {
      rBody.innerHTML = data.recent.map((o) => `
        <tr>
          <td class="mono">${esc(o.label)}</td>
          <td><span class="tag ${esc(o.kind)}">${esc(o.kind)}</span></td>
          <td class="num">${fmtDuration(o.durationMs)}</td>
          <td class="outcome-${esc(o.outcome)}">${esc(o.outcome)}</td>
          <td class="num">${o.statusCode == null ? "-" : esc(o.statusCode)}</td>
          <td class="num">${timeAgo(o.completedAtUtc)}</td>
        </tr>`).join("");
    }
  }

  async function pollLogs() {
    if (logPaused) return;
    let data;
    try { data = await api(`/api/monitor/logs?after=${logLastSeq}`); } catch { return; }
    logLastSeq = data.lastSeq;
    if (!data.lines.length) return;

    const pane = $("log-pane");
    const atBottom = pane.scrollHeight - pane.scrollTop - pane.clientHeight < 40;
    const frag = document.createDocumentFragment();
    for (const line of data.lines) {
      const div = document.createElement("div");
      div.className = "log-line " + lvlClass(line.text);
      div.textContent = line.text;
      frag.appendChild(div);
    }
    pane.appendChild(frag);
    // Trim the DOM so it can't grow unbounded (server ring is bounded too).
    while (pane.childElementCount > 800) pane.removeChild(pane.firstChild);
    if (atBottom) pane.scrollTop = pane.scrollHeight;
  }

  function lvlClass(text) {
    const m = text.match(/\[(TRC|DBG|INF|WRN|ERR|CRT)\]/);
    return m ? "lvl-" + m[1].toLowerCase() : "";
  }

  async function pollCaches() {
    let data;
    try { data = await api("/api/monitor/caches"); } catch { return; }

    $("cache-ttl").textContent =
      `user cache stale after ${data.userCacheTtlSeconds}s · status after ${data.statusStaleAfterSeconds}s`;

    const body = $("cache-rows");
    if (!data.devices.length) {
      body.innerHTML = `<tr class="empty"><td colspan="6">No devices configured.</td></tr>`;
      return;
    }
    body.innerHTML = data.devices.map((d) => {
      const u = d.userCache, s = d.statusCache;
      const ucState = !u.populated
        ? `<span class="badge-state empty">not populated</span>`
        : u.stale
          ? `<span class="badge-state stale">stale</span>`
          : `<span class="badge-state ok">ok</span>`;
      const stState = !s.present
        ? `<span class="badge-state empty">no data</span>`
        : `<span class="badge-state ${s.online ? "online" : "offline"}">${s.online ? "online" : "offline"}</span>`
          + (s.stale ? ` <span class="badge-state stale">stale</span>` : "");
      const dev = d.name ? `${esc(d.name)} <span class="muted">${esc(d.device)}</span>` : `<span class="mono">${esc(d.device)}</span>`;
      return `
        <tr>
          <td>${dev}</td>
          <td class="num">${u.populated ? u.users : "—"}</td>
          <td class="num">${u.populated ? u.groups : "—"}</td>
          <td>${ucState}</td>
          <td class="num">${u.ageSeconds == null ? "—" : ageLabel(u.ageSeconds)}</td>
          <td>${stState}</td>
        </tr>`;
    }).join("");
  }

  function ageLabel(sec) {
    if (sec < 60) return `${Math.round(sec)}s ago`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
    return `${Math.floor(sec / 86400)}d ago`;
  }

  async function loadInfo() {
    let info;
    try { info = await api("/api/monitor/info"); } catch { return; }
    $("hdr-version").textContent = "v" + info.version;
    $("hdr-uptime").textContent = fmtUptime(info.uptimeSeconds);
    const rows = [
      ["Default device", `${info.device.ip}:${info.device.port}`],
      ["Connect timeout", `${info.device.connectTimeoutSeconds}s`],
      ["Read / op timeout", `${info.device.readTimeoutSeconds}s`],
      ["Device-lock max wait", `${info.gateMaxWaitSeconds}s`],
      ["Status poll interval", `${info.monitorIntervalSeconds}s`],
      ["Configured devices", (info.devices && info.devices.length)
        ? info.devices.map((d) => `${d.name || "?"} (${d.ip}:${d.port})`).join(", ")
        : "—"],
      ["API-key auth", info.apiKeyAuth ? "enabled" : "disabled"],
      ["Log buffer", `${info.logBufferSize} lines`],
      ["History size", `${info.historySize} ops`],
      ["Session TTL", `${info.tokenTtlMinutes} min`],
      ["Started", new Date(info.startedAt).toLocaleString()],
    ];
    $("info-grid").innerHTML = rows.map(([k, v]) =>
      `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join("");
  }

  // ---- boot ----
  if (getToken()) start();
  else showLogin();
})();
