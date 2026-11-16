// src/store.js
// In-memory page store. Source of truth for revisions; the carousel reads the
// current revision at emit time, so an edit is "queued onto the carousel" the
// moment the store holds the new revision (design §3, §7).
//
// Revisions are per-page: editing page 201 bumps only page 201's revision and
// timestamp (FR-1.3). Other pages are unaffected.

function pad(n) {
  return String(n).padStart(2, '0');
}

// Build a {utc, local} timestamp from a Date plus a venue UTC offset (minutes).
// `utc` is the ISO string; `local` is a short HH:MM:SS venue-local label so the
// two are visibly distinct on screen (FR-1.2, AC-STALE-1).
export function makeTimestamp(date, venueOffsetMinutes = 60) {
  const utc = date.toISOString();
  const shifted = new Date(date.getTime() + venueOffsetMinutes * 60000);
  const local = `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(shifted.getUTCSeconds())}`;
  return { utc, local };
}

export function createStore({ clock = () => new Date(), venueOffsetMinutes = 60 } = {}) {
  const pages = new Map();

  function ts() {
    return makeTimestamp(clock(), venueOffsetMinutes);
  }

  // Seed state for the anchor workflow (design §4). Page 201 starts at R3/T3
  // with workshop W7 — Latent Diffusion Drift in Hall A; the room-change edit
  // advances it to R4/T4.
  pages.set(100, {
    number: 100,
    revision: 1,
    timestamp: ts(),
    title: 'Index',
    payload: {
      kind: 'index',
      event: 'Kiroween Resurrection',
      date: '2026-11-05',
      venue: 'Hall D · LAN broadcast',
      pages: [100, 201, 301, 500],
    },
  });

  pages.set(201, {
    number: 201,
    revision: 3,
    timestamp: ts(),
    title: 'Workshops',
    payload: {
      kind: 'workshops',
      workshops: [
        { id: 'W7', title: 'Latent Diffusion Drift', room: 'Hall A', slot: '14:00–15:00' },
        { id: 'W8', title: 'Tape Loop Choir', room: 'Hall B', slot: '15:30–16:30' },
        { id: 'W9', title: 'CRT Shader Lab', room: 'Hall A', slot: '17:00–18:00' },
      ],
    },
  });

  pages.set(301, {
    number: 301,
    revision: 1,
    timestamp: ts(),
    title: 'Schedule',
    payload: {
      kind: 'schedule',
      sessions: [
        { id: 'S1', title: 'Doors', time: '13:00' },
        { id: 'S2', title: 'Keynote', time: '13:30' },
        { id: 'S3', title: 'Workshops', time: '14:00' },
      ],
    },
  });

  pages.set(500, {
    number: 500,
    revision: 1,
    timestamp: ts(),
    title: 'Status',
    payload: { kind: 'status', status: 'LIVE', note: 'Bulletin broadcasting on venue LAN' },
  });

  function clone(record) {
    return JSON.parse(JSON.stringify(record));
  }

  function getPage(num) {
    const r = pages.get(num);
    return r ? clone(r) : null;
  }

  function getRevision(num) {
    const r = pages.get(num);
    return r ? r.revision : null;
  }

  function listPages() {
    return [...pages.keys()]
      .sort((a, b) => a - b)
      .map((n) => ({ number: n, revision: pages.get(n).revision, title: pages.get(n).title }));
  }

  // FR-3.2 anchor action: edit a workshop's room on page 201. Bumps that page's
  // revision + timestamp only (FR-1.3). Throws a typed error on bad input so
  // the server can map it to a status code.
  function applyEdit({ page, workshop, room } = {}) {
    const rec = pages.get(page);
    if (!rec) {
      const err = new Error(`Unknown page: ${page}`);
      err.code = 'UNKNOWN_PAGE';
      throw err;
    }
    if (rec.number !== 201 || !Array.isArray(rec.payload && rec.payload.workshops)) {
      const err = new Error(`Page ${page} is not editable via this endpoint`);
      err.code = 'NOT_EDITABLE';
      throw err;
    }
    if (typeof room !== 'string' || room.trim() === '') {
      const err = new Error('Room must be a non-empty string');
      err.code = 'BAD_ROOM';
      throw err;
    }
    const w = rec.payload.workshops.find((x) => x.id === workshop);
    if (!w) {
      const err = new Error(`Unknown workshop: ${workshop}`);
      err.code = 'UNKNOWN_WORKSHOP';
      throw err;
    }
    w.room = room.trim();
    rec.revision += 1;
    rec.timestamp = ts();
    return { num: rec.number, rev: rec.revision, timestamp: clone(rec.timestamp), workshop: w.id, room: w.room };
  }

  return { getPage, getRevision, listPages, applyEdit, _pages: pages };
}
