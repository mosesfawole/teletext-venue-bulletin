// src/schedules.js
// Transmission schedules.
//
// FR-2.4 gives the canonical schedules over the {200,201,202,203} page set, with
// page 201 the urgent page. The live carousel instantiates the *identical*
// pattern over the venue set {100,201,301,500} (same positions, new labels), so
// the wait statistics are unchanged between the two labelings. One pattern, two
// labelings, identical statistics (design §5, §11).

export const URGENT_PAGE = 201;

// Canonical schedules (FR-2.4) — used verbatim by the scheduling benchmark for
// direct traceability to the stated bounds.
export const FIXED_CANONICAL = [200, 201, 202, 203];
export const PRIORITY_CANONICAL = [201, 200, 201, 202, 201, 203];

// Map a canonical page id to its live venue id (same pattern, new labels).
const TO_LIVE = { 200: 100, 201: 201, 202: 301, 203: 500 };

// Live instantiation over {100,201,301,500} — what the carousel actually emits.
export const LIVE_FIXED = FIXED_CANONICAL.map((n) => TO_LIVE[n]);
export const LIVE_PRIORITY = PRIORITY_CANONICAL.map((n) => TO_LIVE[n]);

export const LIVE_SCHEDULES = {
  fixed: LIVE_FIXED,
  priority: LIVE_PRIORITY,
};

export const SCHEDULE_NAMES = ['fixed', 'priority'];

export function liveSchedule(name) {
  const s = LIVE_SCHEDULES[name];
  if (!s) throw new Error(`Unknown schedule: ${String(name)}`);
  return s;
}
