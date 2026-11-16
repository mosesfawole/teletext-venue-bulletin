// public/viewer.js
// Public teletext viewer (design §8). Tunes to a numbered page over SSE,
// rejects stale revisions (never downgrades a held page), and labels
// disconnected data via the NO_SIGNAL / TUNING / LIVE / STALE state machine.
//
// Two drive signals (design §8): slot arrivals (any page = heartbeat;
// matching page = content) and a lastHeard timer (3 missed 1 Hz slots =>
// disconnected). The carousel always emits the current revision, so a held
// page is replaced by a newer one on the next matching slot and never shows a
// superseded revision as current (AC-STALE-1, AC-STALE-2, AC-LATE-1).

(function () {
  "use strict";

  var THRESHOLD_MS = 3000; // 3 missed 1 Hz slots => disconnected (design §8)
  var FALLBACK_PAGES = [100, 201, 301, 500];

  var $ = function (id) { return document.getElementById(id); };
  var statusEl = $("status");
  var statusText = $("status-text");
  var eventLine = $("event-line");
  var pageNumEl = $("page-num");
  var pageTitleEl = $("page-title");
  var pageRevEl = $("page-rev");
  var pageTimeLocalEl = $("page-time-local");
  var pageTimeUtcEl = $("page-time-utc");
  var pageBodyEl = $("page-body");
  var tuneForm = $("tune-form");
  var tuneInput = $("tune-input");
  var tuneQuick = $("tune-quick");
  var signalEl = $("signal");

  // --- state --------------------------------------------------------------
  var tunedPage = 201;
  var held = null;        // {num, rev, ts, title, payload} for the tuned page
  var lastHeard = null;   // performance.now() of last slot/snapshot (heartbeat)
  var everHeard = false;
  var lastSlot = null;    // last slot object (drives the tuning indicator)
  var pages = [];         // page list from snapshot (for quick-tune buttons)
  var carousel = null;    // carousel status from snapshot
  var indexPayload = null; // page 100 payload (dossier header: event/venue/date)
  var es = null;
  var startedAt = performance.now();

  // render guards: rebuild the body only on a state or held-revision change,
  // so the live slot counter can tick without churning the DOM each second.
  var lastState = null;
  var lastHeldSig = null;

  // --- helpers ------------------------------------------------------------
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }
  function pad3(n) {
    return n == null ? "—" : String(n).padStart(3, "0");
  }
  function formatUtc(iso) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})/.exec(iso || "");
    if (!m) return iso || "";
    return m[4] + ":" + m[5] + ":" + m[6] + "Z  " + m[1] + "-" + m[2] + "-" + m[3];
  }

  // --- connection health --------------------------------------------------
  function connected() {
    if (!everHeard || lastHeard == null) return false;
    return performance.now() - lastHeard < THRESHOLD_MS;
  }

  // Adopt a matching page payload, rejecting stale revisions (never downgrade).
  // Accepts either wire shape: the snapshot's full record (number/revision/
  // timestamp) or a slot's flattened page (num/rev/ts).
  function considerPage(raw) {
    if (!raw) return;
    var num = raw.num != null ? raw.num : raw.number;
    var rev = raw.rev != null ? raw.rev : raw.revision;
    if (rev == null || num !== tunedPage) return;
    if (held && rev < held.rev) return; // stale — reject
    held = {
      num: num,
      rev: rev,
      ts: raw.ts || raw.timestamp || null,
      title: raw.title,
      payload: raw.payload,
    };
  }

  // --- SSE ----------------------------------------------------------------
  function connect() {
    try {
      es = new EventSource("/api/stream");
    } catch (e) {
      render();
      return;
    }

    es.addEventListener("snapshot", function (e) {
      var snap;
      try { snap = JSON.parse(e.data); } catch (err) { return; }
      pages = Array.isArray(snap.pages) ? snap.pages : [];
      carousel = snap.carousel || null;
      lastHeard = performance.now();
      everHeard = true;
      if (snap.onAir) {
        var onNum = snap.onAir.number;
        if (onNum === 100) applyIndex(snap.onAir.payload);
        if (onNum === tunedPage) considerPage(snap.onAir);
      }
      renderQuick();
      render();
    });

    es.addEventListener("message", function (e) {
      var slot;
      try { slot = JSON.parse(e.data); } catch (err) { return; }
      lastHeard = performance.now();
      everHeard = true;
      lastSlot = slot;
      var p = slot && slot.page;
      if (p) {
        if (p.num === 100) applyIndex(p.payload);
        if (p.num === tunedPage) considerPage(p);
      }
      render();
    });

    es.addEventListener("error", function () {
      // EventSource auto-reconnects; the lastHeard timer drives stale/no-signal.
      render();
    });
  }

  // --- dossier header (event -> date/venue) from page 100 -----------------
  function loadHeader() {
    fetch("/api/page/100", { headers: { Accept: "application/json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (p) { if (p && p.payload) applyIndex(p.payload); })
      .catch(function () { /* offline: header fills from SSE 100 slots instead */ });
  }
  function applyIndex(payload) {
    if (!payload || payload.kind !== "index") return;
    indexPayload = payload;
    var bits = [];
    if (payload.event) bits.push('<span class="ev-name">' + esc(payload.event) + "</span>");
    if (payload.date) bits.push(esc(payload.date));
    if (payload.venue) bits.push(esc(payload.venue));
    eventLine.hidden = bits.length === 0;
    eventLine.innerHTML = bits.join("  ·  ");
  }

  // --- tuning -------------------------------------------------------------
  function tuneTo(num) {
    if (!Number.isFinite(num)) return;
    tunedPage = num;
    held = null; // fresh tune: wait for the next matching slot (design FR-2.2)
    pageNumEl.textContent = pad3(num);
    renderQuick();
    render();
  }

  tuneForm.addEventListener("submit", function (e) {
    e.preventDefault();
    var n = parseInt(tuneInput.value, 10);
    if (Number.isFinite(n)) {
      n = Math.min(999, Math.max(100, n));
      tuneInput.value = String(n);
      tuneTo(n);
    }
  });

  function renderQuick() {
    var list = pages.length
      ? pages.map(function (p) { return p.number; })
      : FALLBACK_PAGES.slice();
    tuneQuick.innerHTML = "";
    list.forEach(function (n) {
      var b = document.createElement("button");
      b.type = "button";
      b.textContent = String(n);
      if (n === tunedPage) b.classList.add("active");
      b.addEventListener("click", function () {
        tuneInput.value = String(n);
        tuneTo(n);
      });
      tuneQuick.appendChild(b);
    });
  }

  // --- state machine + render --------------------------------------------
  function stateLabel(s) {
    return {
      connecting: "connecting",
      live: "live",
      tuning: "tuning",
      stale: "stale",
      nosignal: "no signal",
    }[s];
  }

  function computeState() {
    var conn = connected();
    var has = !!held && held.num === tunedPage;
    if (has && conn) return "live";
    if (has && !conn) return "stale";
    if (!has && conn) return "tuning";
    if (!everHeard && performance.now() - startedAt < THRESHOLD_MS) return "connecting";
    return "nosignal";
  }

  function setStatus(state) {
    statusEl.classList.remove(
      "is-connecting", "is-live", "is-tuning", "is-stale", "is-nosignal"
    );
    statusEl.classList.add("is-" + state);
    statusText.textContent = stateLabel(state);
  }

  function render() {
    var state = computeState();
    var heldSig = held ? held.num + ":" + held.rev + ":" + (held.ts && held.ts.utc) : "";

    if (state !== lastState || heldSig !== lastHeldSig) {
      lastState = state;
      lastHeldSig = heldSig;
      setStatus(state);
      if (held && held.num === tunedPage) {
        renderPage(held, state === "stale");
      } else {
        renderStateMessage(state);
      }
    }
    renderTuningIndicator();
    renderSignal();
  }

  // Live-update the slot counter inside the tuning message without a full body
  // rebuild (keeps the blink animation running and avoids DOM churn).
  function tuningText() {
    if (!lastSlot) return "listening…";
    return (
      "on air P" + pad3(lastSlot.page && lastSlot.page.num) +
      " · slot " + (lastSlot.slot != null ? lastSlot.slot : "?") +
      " · " + esc(lastSlot.schedule || "")
    );
  }
  function tuningIndicatorHtml() {
    return '<span class="pulse"></span><span class="slot-text">' + tuningText() + "</span>";
  }
  function renderTuningIndicator() {
    if (lastState !== "tuning") return;
    var ind = pageBodyEl.querySelector(".slot-ind");
    if (!ind) return;
    var t = ind.querySelector(".slot-text");
    if (!t) { ind.innerHTML = tuningIndicatorHtml(); return; }
    var text = tuningText();
    if (t.getAttribute("data-text") !== text) {
      t.innerHTML = text;
      t.setAttribute("data-text", text);
    }
  }

  function renderPage(p, stale) {
    pageTitleEl.textContent = p.title || "—";
    pageRevEl.textContent = p.rev != null ? "R" + p.rev : "—";
    var ts = p.ts || {};
    pageTimeLocalEl.textContent = ts.local || "—";
    pageTimeUtcEl.textContent = ts.utc ? formatUtc(ts.utc) : "";

    var body = "";
    if (stale) body += '<div class="stale-banner">stale / disconnected — last known</div>';
    body += renderPayload(p.payload);
    pageBodyEl.innerHTML = body;
  }

  function renderStateMessage(state) {
    pageTitleEl.textContent = "—";
    pageRevEl.textContent = "—";
    pageTimeLocalEl.textContent = "—";
    pageTimeUtcEl.textContent = "";

    if (state === "tuning") {
      var known = pages.length === 0 || pages.some(function (p) { return p.number === tunedPage; });
      var sub = known
        ? "waiting for page " + pad3(tunedPage) + " on the carousel"
        : "page " + pad3(tunedPage) + " is not in the current bulletin";
      pageBodyEl.innerHTML =
        '<div class="state-msg tuning"><div class="big">tuning</div>' +
        '<div class="state-sub">' + sub + "</div>" +
        '<div class="slot-ind">' + tuningIndicatorHtml() + "</div></div>";
    } else if (state === "nosignal") {
      pageBodyEl.innerHTML =
        '<div class="state-msg nosignal"><div class="big">no signal</div>' +
        '<div class="state-sub">bulletin stream unreachable — keep this page open</div></div>';
    } else {
      pageBodyEl.innerHTML =
        '<div class="state-msg"><div class="big" style="color: var(--ink-dim)">connecting</div>' +
        '<div class="state-sub">linking to transmitter…</div></div>';
    }
  }

  function renderSignal() {
    var parts = [];
    if (carousel) {
      parts.push("schedule " + esc(carousel.schedule || "—"));
      parts.push("slot " + (carousel.slot != null ? carousel.slot : "?"));
      parts.push((carousel.pages || 0) + " pages");
    }
    if (lastSlot) parts.push("on-air P" + pad3(lastSlot.page && lastSlot.page.num));
    if (lastHeard != null) {
      var ago = Math.max(0, Math.round((performance.now() - lastHeard) / 100) / 10);
      parts.push("last " + ago.toFixed(1) + "s ago");
    }
    signalEl.hidden = parts.length === 0;
    signalEl.textContent = parts.join("  ·  ");
  }

  // --- payload renderers --------------------------------------------------
  function renderPayload(payload) {
    if (!payload || typeof payload !== "object") {
      return '<div class="muted">No content on this page.</div>';
    }
    switch (payload.kind) {
      case "workshops": return renderWorkshops(payload.workshops);
      case "index": return renderIndex(payload);
      case "schedule": return renderSchedule(payload.sessions);
      case "status": return renderStatus(payload);
      default:
        return '<pre class="raw-payload">' + esc(JSON.stringify(payload, null, 2)) + "</pre>";
    }
  }

  function renderWorkshops(workshops) {
    if (!Array.isArray(workshops) || !workshops.length) {
      return '<div class="muted">No workshops listed.</div>';
    }
    return (
      '<div class="ws">' +
      workshops
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
        .join("") +
      "</div>"
    );
  }

  function renderIndex(p) {
    var rows = [];
    if (p.event) rows.push(idxRow("Event", esc(p.event)));
    if (p.date) rows.push(idxRow("Date", esc(p.date)));
    if (p.venue) rows.push(idxRow("Venue", esc(p.venue)));
    if (Array.isArray(p.pages)) {
      rows.push(idxRow("Pages", p.pages.map(function (n) { return String(n); }).join("  ·  ")));
    }
    return '<div class="idx-list">' + rows.join("") + "</div>";
  }
  function idxRow(k, v) {
    return '<div class="idx-row"><span class="label">' + k + "</span><span>" + v + "</span></div>";
  }

  function renderSchedule(sessions) {
    if (!Array.isArray(sessions) || !sessions.length) {
      return '<div class="muted">No sessions listed.</div>';
    }
    return (
      '<div class="sched-list">' +
      sessions
        .map(function (s) {
          return (
            '<div class="sched-row"><span>' + esc(s.title) + "</span>" +
            '<span class="muted">' + esc(s.time || "") + "</span></div>"
          );
        })
        .join("") +
      "</div>"
    );
  }

  function renderStatus(p) {
    var big = p.status ? '<div class="stat-big">' + esc(p.status) + "</div>" : "";
    var note = p.note
      ? '<div class="muted" style="margin-top: 0.45rem">' + esc(p.note) + "</div>"
      : "";
    return '<div class="stat">' + big + note + "</div>";
  }

  // --- init ---------------------------------------------------------------
  renderQuick();
  render();
  loadHeader();
  connect();
  // Re-evaluate on a timer so staleness (no new events) flips the state.
  setInterval(render, 250);
})();
