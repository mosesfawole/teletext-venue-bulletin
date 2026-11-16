// public/staff/staff.js
// Staff authoring surface (design §7). Login-gated; edits page 201 room via
// the authenticated /api/staff/edit endpoint. Tracks connection health by
// polling /api/staff/status (a lightweight authed ping) and queue/retries an
// unsaved edit while offline, surfacing connected / saving / saved /
// offline-unsaved states (FR-3.3, AC-OFF-1).
//
// Auth: the login response carries a bearer token (kept in memory and sent as
// the Authorization header). The transmitter also sets an HttpOnly
// staff_token cookie, which is sent automatically on same-origin requests, so
// an existing session survives a page reload even though the in-memory token
// is gone.

(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var loginView = $("login-view");
  var editorView = $("editor-view");
  var loginForm = $("login-form");
  var loginPass = $("login-pass");
  var loginError = $("login-error");
  var loginBtn = $("login-btn");
  var logoutBtn = $("logout-btn");
  var connEl = $("conn");
  var connText = $("conn-text");
  var sTitle = $("s-title");
  var sRev = $("s-rev");
  var sTimeLocal = $("s-time-local");
  var sTimeUtc = $("s-time-utc");
  var wsTable = $("ws-table");
  var editForm = $("edit-form");
  var editWs = $("edit-ws");
  var editRoom = $("edit-room");
  var editBtn = $("edit-btn");
  var editStatus = $("edit-status");
  var schedRadios = $("sched-radios");
  var sCarousel = $("s-carousel");
  var schedStatus = $("sched-status");

  var bearer = null;     // in-memory token from login (cookie also set)
  var authed = false;
  var online = false;
  var prevOnline = false;
  var page201 = null;     // last fetched page 201 record
  var pendingEdit = null; // {workshop, room} queued while offline
  var pollTimer = null;
  var last201rev = null;

  // --- helpers ------------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function formatUtc(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso || "");
    if (!m) return iso || "";
    return m[4] + ":" + m[5] + ":" + m[6] + "Z  " + m[1] + "-" + m[2] + "-" + m[3];
  }
  function authHeaders() {
    var h = {};
    if (bearer) h.Authorization = "Bearer " + bearer;
    return h;
  }
  function jsonHeaders() {
    return Object.assign({ "Content-Type": "application/json" }, authHeaders());
  }

  function setConn(state, text) {
    connEl.classList.remove("is-connecting", "is-live", "is-stale", "is-nosignal", "is-tuning");
    connEl.classList.add("is-" + state);
    connText.textContent = text;
  }

  function setEdit(kind, html) {
    editStatus.hidden = false;
    editStatus.classList.remove("saved", "saving", "offline", "error");
    editStatus.classList.add(kind);
    editStatus.innerHTML = html;
  }

  // --- login --------------------------------------------------------------
  loginForm.addEventListener("submit", function (e) {
    e.preventDefault();
    loginError.hidden = true;
    loginBtn.disabled = true;
    loginBtn.textContent = "Signing in…";

    fetch("/api/staff/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: loginPass.value }),
    })
      .then(function (r) {
        return r.json().then(function (body) {
          return { ok: r.ok, status: r.status, body: body };
        });
      })
      .then(function (res) {
        loginBtn.disabled = false;
        loginBtn.textContent = "Sign in";
        if (res.ok && res.body && res.body.token) {
          bearer = res.body.token;
          authed = true;
          loginPass.value = "";
          enterEditor();
        } else {
          loginError.hidden = false;
          loginError.textContent =
            (res.body && res.body.error) || "Sign-in failed.";
          if (res.status === 401) {
            loginError.textContent +=
              " (check the secret, or editing may be disabled on the transmitter)";
          }
        }
      })
      .catch(function () {
        loginBtn.disabled = false;
        loginBtn.textContent = "Sign in";
        loginError.hidden = false;
        loginError.textContent =
          "Cannot reach the transmitter. Are you on the venue LAN?";
      });
  });

  logoutBtn.addEventListener("click", function () {
    fetch("/api/staff/logout", { method: "POST", headers: authHeaders() })
      .finally(function () {
        stopPolling();
        bearer = null;
        authed = false;
        online = false;
        page201 = null;
        pendingEdit = null;
        editorView.hidden = true;
        loginView.hidden = false;
        loginPass.value = "";
        loginError.hidden = true;
        setConn("connecting", "checking…");
      });
  });

  function enterEditor() {
    loginView.hidden = true;
    editorView.hidden = false;
    setConn("connecting", "checking…");
    startPolling();
    refreshPage201();
  }

  // --- connection / auth polling -----------------------------------------
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(poll, 3000);
    poll();
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  function poll() {
    if (!authed) return;
    fetch("/api/staff/status", { headers: authHeaders() })
      .then(function (r) {
        if (r.status === 401) { handleAuthLost(); throw new Error("auth"); }
        if (!r.ok) throw new Error("status " + r.status);
        return r.json();
      })
      .then(function (data) {
        prevOnline = online;
        online = true;
        setConn("live", "connected");
        if (data && data.carousel) updateCarousel(data.carousel);
        var revs = (data && data.store && data.store.pages) || [];
        var r201 = revs.filter(function (p) { return p.number === 201; })[0];
        var newRev = r201 ? r201.revision : null;
        if (newRev != null && newRev !== last201rev) {
          last201rev = newRev;
          refreshPage201();
        } else if (!page201) {
          refreshPage201();
        }
        if (!prevOnline && online && pendingEdit) flushPending();
      })
      .catch(function (err) {
        if (err && err.message === "auth") return; // handled by handleAuthLost
        prevOnline = online;
        online = false;
        setConn("stale", "offline");
        if (pendingEdit) setEdit("offline", "Offline — unsaved edit queued; will retry when reconnected.");
      });
  }

  function handleAuthLost() {
    stopPolling();
    bearer = null;
    authed = false;
    online = false;
    editorView.hidden = true;
    loginView.hidden = false;
    loginError.hidden = false;
    loginError.textContent = "Session expired. Please sign in again.";
    setConn("connecting", "checking…");
  }

  function updateCarousel(c) {
    sCarousel.textContent =
      "schedule " + esc(c.schedule || "—") +
      " · slot " + (c.slot != null ? c.slot : "?") +
      " · " + (c.subscribers != null ? c.subscribers : 0) + " viewer(s) connected";
    schedRadios.querySelectorAll('input[name="sched"]').forEach(function (r) {
      var on = r.value === c.schedule;
      r.checked = on;
      r.closest("label.radio").classList.toggle("is-active", on);
    });
  }

  // --- page 201 display ---------------------------------------------------
  function refreshPage201() {
    fetch("/api/page/201")
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) {
        if (!p) return;
        page201 = p;
        last201rev = p.revision;
        renderPage201();
      })
      .catch(function () { /* keep last known while offline */ });
  }

  function renderPage201() {
    if (!page201) return;
    sTitle.textContent = page201.title || "Workshops";
    sRev.textContent = "R" + page201.revision;
    var ts = page201.timestamp || {};
    sTimeLocal.textContent = ts.local || "—";
    sTimeUtc.textContent = ts.utc ? formatUtc(ts.utc) : "";

    var ws = (page201.payload && page201.payload.workshops) || [];
    wsTable.innerHTML = ws
      .map(function (w) {
        return (
          '<div class="ws-row">' +
          '<span class="ws-id">' + esc(w.id) + "</span>" +
          '<span class="ws-title">' + esc(w.title) + "</span>" +
          '<span class="ws-room">' + esc(w.room) + "</span>" +
          '<span class="ws-slot">' + esc(w.slot || "") + "</span>" +
          "</div>"
        );
      })
      .join("");

    var prev = editWs.value;
    editWs.innerHTML = ws
      .map(function (w) {
        return (
          '<option value="' + esc(w.id) + '">' +
          esc(w.id) + " — " + esc(w.title) +
          "</option>"
        );
      })
      .join("");
    if (prev && ws.some(function (w) { return w.id === prev; })) editWs.value = prev;
    updateRoomPlaceholder();
  }

  function currentSelectedWorkshop() {
    if (!page201) return null;
    var ws = (page201.payload && page201.payload.workshops) || [];
    return ws.filter(function (w) { return w.id === editWs.value; })[0] || null;
  }
  function updateRoomPlaceholder() {
    var w = currentSelectedWorkshop();
    editRoom.placeholder = w ? "current: " + w.room : "new room";
  }
  editWs.addEventListener("change", updateRoomPlaceholder);

  // --- edit flow ----------------------------------------------------------
  editForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var workshop = editWs.value;
    var room = (editRoom.value || "").trim();
    if (!workshop) { setEdit("error", "Pick a workshop first."); return; }
    if (!room) { setEdit("error", "Enter a room name."); return; }
    submitEdit(workshop, room, true);
  });

  function submitEdit(workshop, room, allowQueue) {
    setEdit("saving", "Saving…");
    editBtn.disabled = true;
    fetch("/api/staff/edit", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ page: 201, workshop: workshop, room: room }),
    })
      .then(function (r) {
        return r.json().then(function (body) {
          return { ok: r.ok, status: r.status, body: body };
        });
      })
      .then(function (res) {
        editBtn.disabled = false;
        if (res.ok) {
          pendingEdit = null;
          var b = res.body || {};
          setEdit(
            "saved",
            "Saved · " + esc(b.workshop || "") + " &rarr; " + esc(b.room || "") +
              " · rev R" + (b.rev != null ? b.rev : "?") +
              " · " + esc((b.timestamp && b.timestamp.local) || "")
          );
          editRoom.value = "";
          refreshPage201();
        } else if (res.status === 401) {
          handleAuthLost();
        } else {
          setEdit(
            "error",
            esc((res.body && res.body.error) || ("Edit failed (" + res.status + ")"))
          );
        }
      })
      .catch(function () {
        // network failure: hold the edit and retry on reconnect (FR-3.3)
        editBtn.disabled = false;
        if (allowQueue) {
          pendingEdit = { workshop: workshop, room: room };
          online = false;
          setConn("stale", "offline");
          setEdit("offline", "Offline — unsaved (queued). Will retry when reconnected.");
        } else {
          setEdit("offline", "Still offline — edit remains queued.");
        }
      });
  }

  function flushPending() {
    if (!pendingEdit) return;
    var pe = pendingEdit;
    setEdit("saving", "Retrying saved edit…");
    fetch("/api/staff/edit", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ page: 201, workshop: pe.workshop, room: pe.room }),
    })
      .then(function (r) {
        return r.json().then(function (body) {
          return { ok: r.ok, status: r.status, body: body };
        });
      })
      .then(function (res) {
        if (res.ok) {
          pendingEdit = null;
          var b = res.body || {};
          setEdit(
            "saved",
            "Saved · " + esc(b.workshop || "") + " &rarr; " + esc(b.room || "") +
              " · rev R" + (b.rev != null ? b.rev : "?") +
              " · " + esc((b.timestamp && b.timestamp.local) || "")
          );
          editRoom.value = "";
          refreshPage201();
        } else if (res.status === 401) {
          handleAuthLost();
        } else {
          setEdit(
            "offline",
            "Retry failed: " + esc((res.body && res.body.error) || res.status) +
              " — edit still queued."
          );
        }
      })
      .catch(function () {
        setEdit("offline", "Still offline — edit remains queued.");
      });
  }

  // --- schedule switch ----------------------------------------------------
  schedRadios.addEventListener("change", function (e) {
    var t = e.target;
    if (t.name !== "sched") return;
    schedRadios.querySelectorAll("label.radio").forEach(function (l) {
      var inp = l.querySelector("input");
      l.classList.toggle("is-active", inp.checked);
    });
    var name = t.value;
    fetch("/api/staff/schedule", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ schedule: name }),
    })
      .then(function (r) {
        return r.json().then(function (body) {
          return { ok: r.ok, status: r.status, body: body };
        });
      })
      .then(function (res) {
        if (res.ok && res.body) {
          updateCarousel(res.body);
          schedStatus.hidden = true;
        } else if (res.status === 401) {
          handleAuthLost();
        } else {
          schedStatus.hidden = false;
          schedStatus.className = "edit-status error";
          schedStatus.textContent =
            "Schedule change failed: " + ((res.body && res.body.error) || res.status);
        }
      })
      .catch(function () {
        setConn("stale", "offline");
        schedStatus.hidden = false;
        schedStatus.className = "edit-status offline";
        schedStatus.textContent = "Offline — schedule change will need to be retried.";
      });
  });

  // --- init: detect an existing session (cookie) -------------------------
  function showLogin() {
    loginView.hidden = false;
    editorView.hidden = true;
    setConn("connecting", "checking…");
    setTimeout(function () { if (!authed) loginPass.focus(); }, 0);
  }

  fetch("/api/staff/status", { headers: authHeaders() })
    .then(function (r) {
      if (r.status === 401 || !r.ok) { showLogin(); return null; }
      return r.json();
    })
    .then(function (data) {
      if (!data) return;
      authed = true;
      if (data.carousel) updateCarousel(data.carousel);
      enterEditor();
    })
    .catch(function () { showLogin(); });
})();
