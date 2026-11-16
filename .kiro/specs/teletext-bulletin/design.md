# Teletext Venue Bulletin — Design

> Status: **Design drafted.** This pass defines *how* the prototype is built for the two in-scope deliverables only: the **room-change flow** (the anchor workflow) and the **repeatable scheduling evaluation**. Implementation, task breakdown, code, tests, and on-phone evidence artifacts are explicitly out of scope here and belong to later passes.
>
> Companion: [`requirements.md`](./requirements.md). This design resolves the open questions listed in §9 of the requirements. Visual reference: the [Signale Framer template](https://www.framer.com/marketplace/templates/signale/) — used as **reference only**, never bundled or fetched (NFR-1, AC-RUN-1).

## 1. Scope of this design

**In scope (this design):**
- The room-change flow end-to-end: staff edits a workshop's room (authenticated) → revision/timestamp bump → carousel → late-joining viewer on the venue LAN renders the new room, revision and timestamp.
- The deterministic, repeatable comparison of the **fixed** vs **priority** page cycles at one equal-sized slot per second across all join phases, reporting urgent- and routine-page mean waits and bounded worst-case waits.
- Connection/unavailable status for both audiences, including the attendee UI's handling of stale and disconnected data.

**Out of scope (later passes):**
- Implementation, `tasks.md`, code, automated tests, and the on-phone evidence log. This document stops at design.

The directive constraints this design honors explicitly:
- **Node.js with SSE** carries the slot stream over the venue LAN (resolves Open Question 1).
- **Staff mutations are authenticated**; the public viewer cannot mutate.
- **The attendee UI keeps the viewer informed about stale or disconnected data** (distinct from a blank page).
- **One equal-sized slot per second** in both schedules; worst-case priority waits are **2 s for page 201** and **6 s for routine pages**; the fixed baseline is **4 s maximum per page**.

## 2. Design goals and constraints

- **NFR-1 Self-contained runtime.** A single Node.js process serves the public viewer, the staff surface, and the SSE slot stream. No paid service and no external network assets; Signale is reference-only and is neither bundled nor fetched. System monospace fonts and a locally-defined dark palette stand in for the Signale look.
- **NFR-2 Visual language (Signale).** Dark near-black surface, hairline borders, restrained red/blue glow; monospace labels for page number, revision, timestamp and slot indicator; event-hierarchy reading order (event → date/venue → page index → page content).
- **NFR-3 Deterministic simulation.** The scheduling comparison is reproducible from a fixed seed; re-running yields identical numbers. The default mode enumerates all join phases exhaustively, so it is deterministic by construction; the seed is recorded in the report for completeness.
- **Separation of audiences.** Staff and public entry points and privileges are distinct (FR-3.1).

## 3. Architecture overview

```
                       Venue LAN (HTTP over TCP)
   ┌──────────────────────────────────────────────────────────┐
   │                    Node.js Transmitter                    │
   │  ┌─────────────┐   ┌─────────────┐   ┌─────────────────┐  │
   │  │  Page Store  │◄──│ Staff API   │   │  Carousel/Ticker│  │
   │  │ (in-memory)  │   │ (auth-gated)│   │  1 slot / second │  │
   │  └──────┬───────┘   └─────────────┘   └────────┬────────┘  │
   │         │ current revision read at emit time   │           │
   │         └──────────────────────────────────────►│           │
   │                                              emit slot     │
   │                         ┌────────────────────────┴────────┐  │
   │                         │           SSE  /stream           │  │
   │                         │  (one event per slot + heartbeat)│  │
   │                         └────────────┬───────────┬────────┘  │
   └──────────────────────────────────────┼───────────┼──────────┘
                              GET /        │           │  GET /staff
                       (public viewer)     │           │ (auth-gated UI)
                                              ▼           ▼
                                  ┌────────────────┐  ┌────────────────┐
                                  │  Public viewer  │  │  Staff authoring│
                                  │   (phone)       │  │    surface       │
                                  └────────────────┘  └────────────────┘

   ┌────────────────────────────────────────────────────────────┐
   │   Scheduling simulator (offline, deterministic)            │
   │   inputs: fixed/priority schedules, page set, seed         │
   │   outputs: mean + worst-case waits per (scheme × class)     │
   └────────────────────────────────────────────────────────────┘
```

Components:
- **Page Store** — in-memory map of page number → page record. Source of truth for revisions; read by the carousel at emit time.
- **Staff API** — authenticated mutation endpoint; validates auth, applies edits, bumps revision/timestamp.
- **Carousel / Ticker** — advances a pointer through the active schedule once per second and emits the current revision of the scheduled page as one slot.
- **SSE `/stream`** — pushes every slot to all connected viewers; the slot cadence doubles as the connection heartbeat.
- **Public viewer surface** — static page served at `/`; uses `EventSource` to receive slots, filters for the tuned page, drives the state machine.
- **Staff authoring surface** — served at `/staff`; login-gated; performs authenticated commits.
- **Scheduling simulator** — offline, pure function; produces the comparison report. Independent of the live transmitter so its numbers are reproducible regardless of wall-clock drift.

## 4. Content and addressing model (FR-1)

- **FR-1.1** The live carousel page set is `{100, 201, 301, 500}`:
  - `100` Index, `201` Workshops (the page under test), `301` Schedule, `500` Status.
  - Four pages keep the carousel non-trivial without over-building (resolves Open Question 4).
- **FR-1.2** Each page record carries: `number` (3-digit), `revision` (monotonic integer per page), `timestamp` (UTC ISO + venue-local label), and a structured `payload`. Page `201`'s payload is `workshops: [{ id, title, room, slot }, …]`.
- **Seed state for the anchor workflow:** page `201` at revision `R3`, timestamp `T3`, workshop `W7 — Latent Diffusion Drift` in `Hall A`.
- **FR-1.3** Editing any field on a page increments that page's `revision` and updates its `timestamp` only. Other pages are unaffected; revisions are per-page.

## 5. Transmission / carousel model (FR-2)

- **FR-2.1** The transmitter emits discrete **slots**; one slot carries exactly one page's current revision. The repeating sequence of slots is the **cycle**.
- **FR-2.2** A viewer tunes to a page number and listens to the slot stream; it renders the page the first time its number appears in a slot after the viewer joined.
- **Slot duration = 1 second, equal-sized in both schemes** (AC-SCHED-1). Equal bandwidth is defined as one equal-sized slot per second; cycle lengths may differ. This measures scheduling delay, independent of network throughput.
- **Schedules.** FR-2.4 gives the canonical schedules over the page set `{200, 201, 202, 203}`. The live carousel instantiates the **identical pattern** over the live set `{100, 201, 301, 500}` (so the wait statistics are unchanged), with page `201` the urgent page in both:

| Scheme   | FR-2.4 canonical schedule | Live instantiation over {100,201,301,500} | Cycle length |
|----------|---------------------------|-------------------------------------------|--------------|
| Fixed    | `[200, 201, 202, 203]`    | `[100, 201, 301, 500]`                    | 4 slots      |
| Priority | `[201, 200, 201, 202, 201, 203]` | `[201, 100, 201, 301, 201, 500]`   | 6 slots      |

  The priority cycle transmits `201` three times per cycle (slots 0, 2, 4) and each other page once. The fixed cycle transmits each page once.
- **FR-2.5** Join phase is the slot offset within the cycle at which a viewer starts listening; the evaluation covers **all** join phases.
- The active schedule is configurable; the anchor workflow is exercised under **both** schedules.

## 6. Transport — Node.js + SSE over the venue LAN (resolves Open Question 1)

- A single Node.js HTTP server (minimal dependencies; self-contained) listens on a venue-LAN address.
- **`GET /stream`** — the SSE endpoint:
  - Headers: `Content-Type: text/event-stream`, `Cache-Control: no-store`, `Connection: keep-alive`.
  - One event per emitted slot: `data: {"slot":k,"schedule":"priority","page":{"num":201,"rev":4,"ts":"T4","payload":{…}}}\n\n`.
  - Because a slot is emitted every second, the slot stream is itself a 1 Hz heartbeat; no separate keepalive is required. (A comment line `: ping` may be sent on any second the ticker is idle, though the ticker runs continuously while live.)
- **Viewer subscription model.** A viewer opens `EventSource('http://<lan-ip>:<port>/stream')` and receives **all** slots. It filters client-side for its tuned page number and uses **every** incoming slot (for any page) as a connection-health heartbeat. Receiving the full stream also lets the UI show the carousel advancing ("tuning…") while it waits, matching the teletext feel.
- **Served surfaces (same origin):**
  - `GET /` — public viewer (static HTML/JS/CSS; system monospace, local dark palette; no external assets).
  - `GET /staff` — staff authoring surface (auth-gated; see §7).
- `EventSource` auto-reconnects; combined with the `lastHeard` timeout (§8) this drives the stale/disconnected states. No TLS is assumed on the trusted venue LAN (a design decision; does not affect any acceptance criterion).

## 7. Staff authoring surface — separated and authenticated (FR-3)

- **FR-3.1 Separation.** Staff entry is `/staff`, distinct from the public viewer at `/`. The public surface exposes no mutation capability and no staff controls.
- **Authentication (mutations authenticated).**
  - A shared secret is read from an environment variable (`STAFF_SECRET`) at server start. It is never baked into code or logs (secure-by-default: secret in env).
  - `POST /api/staff/login` with `{ "password": "<STAFF_SECRET>" }` issues a bearer token (set as an `HttpOnly` cookie or returned for the `Authorization: Bearer` header). Tokens are short-lived and held in memory.
  - `POST /api/staff/edit` **requires** a valid token; an unauthenticated or expired token yields `401`. The public viewer has no path to this endpoint's mutation behavior.
- **Commit flow (FR-3.2).** `POST /api/staff/edit { "page": 201, "workshop": "W7", "room": "Room B" }`:
  1. Validate auth (else `401`).
  2. Validate the page/workshop exist and the field is editable.
  3. Mutate the page store: set `W7.room = "Room B"`; increment page `201` revision (`R3 → R4`); set `timestamp = T4` (now). Other pages unchanged.
  4. Return the new `{ rev, ts }` to the staff UI.
  5. The carousel reads current state at emit time, so the **next** `201` slot carries `R4 / T4`. The edit is "queued onto the carousel" by virtue of the store already holding the new revision.
- **Offline / unsaved state (FR-3.3, AC-OFF-1).** The staff UI tracks connection health (a lightweight `/api/staff/health` ping, or reuse of the SSE stream). Design decision: **queue-and-retry with a visible badge** — when offline, the commit is held locally, shown as **"unsaved / offline"**, and retried automatically on reconnect; an edit is never silently lost. States surfaced to staff: *connected / saving*, *saved (rev bumped)*, *offline — unsaved (queued)*.

## 8. Public viewer surface — the phone (FR-4)

- **FR-4.1** The viewer lets a phone on the venue LAN enter a page number (`201` in the anchor flow) and renders the page once a matching slot arrives.
- **FR-4.2 / AC-STALE-1** The viewer **always** renders the revision number and timestamp of the page it is showing, so a stale page is identifiable on screen, never hidden.
- **State machine.** The viewer is driven by two signals: slot arrivals (any page = heartbeat; matching page = content) and a `lastHeard` timer. Disconnect threshold = 3 s (three missed slots); tunable.

| State | Condition | What is shown | Distinct from |
|-------|-----------|---------------|---------------|
| `NO_SIGNAL` | No page received **and** connection down (no slot for > threshold) | A clear **"no signal"** indicator | a blank page (FR-4.3, AC-OFF-2) |
| `TUNING` | Connected (slots heard recently) but the tuned page not yet received | **"tuning… 201"** with the carousel/slot indicator advancing | a blank page (AC-LATE-2) |
| `LIVE` | A matching slot has been received **and** connection healthy (`lastHeard` fresh) | Room, **revision**, **timestamp** rendered as current | — |
| `STALE` | A page was received but the connection has since dropped (`lastHeard` stale) | The **last-known** room/revision/timestamp **plus a "stale / disconnected" badge** | presenting cached content as live (FR-4.4, AC-STALE-3) |

- **Late-arrival resolution (AC-LATE-1, AC-LATE-2, AC-LATE-3).** A late-joining viewer starts at an arbitrary join phase, shows `TUNING` (never blank), and resolves to `Room B / R4 / T4` on the first `201` slot after it joined — within at most one full cycle. It never renders the pre-edit `Hall A / R3` as current: the carousel only ever emits the current revision, and the viewer renders the revision it actually receives, labelled with that revision's number and timestamp.
- **Stale replacement (AC-STALE-2).** Because the carousel always emits the current revision and the viewer renders the latest received, once `R4` is broadcast any viewer holding `R3` replaces it with `R4` on the next `201` slot — within the AC-LATE-1 bound — and never persists `R3` labelled as current.

## 9. Scheduling comparison — repeatable evaluation (§7, AC-SCHED)

### 9.1 Simulator design
- A **pure, offline function**. Inputs: the two schedules, the page set, and a fixed `seed`. Outputs: mean and worst-case waits per `(scheme × page class)` plus bound checks.
- **Exhaustive over all join phases** (one phase per slot, `0 … N−1`); no random sampling, so it is deterministic by construction (NFR-3, AC-SCHED-5). The `seed` is recorded in the report for reproducibility stamping; if a sampling mode were ever added it would seed the PRNG.
- The comparison is reported using the **literal FR-2.4 canonical schedules** over `{200, 201, 202, 203}` for direct traceability to the stated bounds. The live carousel uses the identical pattern over `{100, 201, 301, 500}`, so the numbers below also describe the live system's page `201` and routine pages.

### 9.2 Wait convention (stated for reproducibility)
A viewer that tunes in during slot `j` cannot reliably capture a page whose transmission is already in progress in slot `j`; its **wait** is the number of slots until the next *complete* transmission of the requested page **strictly after** the join slot. Consequently:
- **Worst case = the maximum gap between consecutive transmissions of the page** in the cycle.
- **Mean = the average of the wait over all `N` join phases** (one per slot).

This "just-missed" model is the conservative teletext reading and makes the worst-case bounds in AC-SCHED-4 tight (rather than loose by one).

### 9.3 Computed results

**Fixed** `[200, 201, 202, 203]`, `N = 4` — each page appears once per cycle (one gap of size 4):
- Per-page mean wait = `(N+1)/2 = 2.5`; worst case = `N = 4`.

**Priority** `[201, 200, 201, 202, 201, 203]`, `N = 6` — `201` at slots 0, 2, 4 (gaps 2, 2, 2); each routine page once per cycle (one gap of size 6):
- `201` mean = `(2+1+2+1+2+1)/6 = 1.5`; worst case = `2`.
- Routine page mean = `(1+6+5+4+3+2)/6 = 3.5`; worst case = `6`.

### 9.4 Report table (AC-SCHED-2, AC-SCHED-3 — both numbers, both schemes, honest)

| Scheme   | Urgent-page mean wait (slots) | Routine-page mean wait (slots) |
|----------|-------------------------------|--------------------------------|
| Fixed    | 2.5                           | 2.5                            |
| Priority | 1.5                           | 3.5                            |

Priority lowers the urgent-page mean wait (2.5 → 1.5) **at the cost of raising** the routine-page mean wait (2.5 → 3.5). Both figures are reported, not only the favorable one.

### 9.5 Worst-case waits and bound checks (AC-SCHED-4)

| Scheme   | Page 201 worst (slots = seconds) | Routine worst (slots = seconds) | Bound | Result |
|----------|----------------------------------|---------------------------------|-------|--------|
| Fixed    | 4                                | 4                               | ≤ 4 s per page (fixed baseline) | **PASS** |
| Priority | 2                                | 6                               | 201 ≤ 2 s; routine ≤ 6 s       | **PASS** |

The directive bounds — **2 s for page 201** and **6 s for routine pages** under priority, and **4 s maximum per page** under fixed — are met exactly (tight under the §9.2 convention).

### 9.6 Cross-check against the anchor bound (AC-LATE-1)
"Within at most one full cycle": fixed `201` worst wait = 4 = one full fixed cycle (4 slots) — within bound; priority `201` worst wait = 2 < one full priority cycle (6 slots) — within bound.

## 10. Visual language — Signale (reference only) (NFR-2, AC-VIS-1)

- **Palette:** near-black surface, hairline borders, restrained red/blue accent glow — defined locally in CSS; no fetched assets.
- **Monospace labels** for page number, revision counter, timestamp and slot indicator.
- **Event-hierarchy reading order:** event name → date/venue → page index → page content, mirroring Signale's dossier layout.
- **Signale is reference-only.** The prototype must not bundle, fetch, or depend on the Framer template, its fonts, or any paid service (NFR-1, AC-RUN-1). System monospace fonts plus the locally-defined palette deliver the language without the asset.

## 11. Resolved open questions (from requirements §9)

1. **Transport over the venue LAN.** → Node.js HTTP server pushing a **Server-Sent Events** slot stream (§6). Slots are the heartbeat; `EventSource` reconnect plus a `lastHeard` timeout drive the offline/stale states. *(Open Question 2 was removed during the requirements correction; numbering preserved.)*
3. **Phone-evidence format.** → A checked-in **evidence manifest** (e.g. `evidence/manifest.json` or a markdown log) records each check with a `device` field of `"real-phone"` or `"simulator"`, plus artifact references (screenshot paths / log excerpts). The repeatable evaluation checks are tagged `"simulator"`; anchor-flow checks performed on an actual handset are tagged `"real-phone"`. The format is fixed now to satisfy AC-EVID-1; artifacts are produced in later passes.
4. **Minimal live page set size.** → Confirmed `{100, 201, 301, 500}` (FR-1.1) is sufficient and non-trivial (four pages, `201` prioritized). The comparison benchmark uses the FR-2.4 literal schedules over `{200, 201, 202, 203}`; the live carousel instantiates the identical pattern over `{100, 201, 301, 500}`, sharing page `201` as the urgent/test page. One pattern, two labelings, identical statistics.

## 12. Traceability to acceptance criteria

| Criterion | Where addressed in this design |
|-----------|--------------------------------|
| AC-LATE-1 (late join shows new room, ≤ one cycle) | §8 state machine, §9.6 cross-check |
| AC-LATE-2 (no blank while tuning) | §8 `TUNING` state |
| AC-LATE-3 (phase-independence) | §9.1 exhaustive over all join phases |
| AC-STALE-1 (revision always visible) | §8 `LIVE`/`STALE` render rev+ts |
| AC-STALE-2 (no silent staleness) | §8 stale replacement; carousel emits only current revision |
| AC-STALE-3 (disconnection marked) | §8 `STALE` state + badge |
| AC-SCHED-1 (equal bandwidth, 1 s slot) | §5 slot duration; §9 schedules |
| AC-SCHED-2 (all join phases) | §9.1 exhaustive enumeration |
| AC-SCHED-3 (honest report) | §9.4 table (both schemes, both classes) |
| AC-SCHED-4 (bounded waits: 2/6/4) | §9.5 worst-case table and bound checks |
| AC-SCHED-5 (reproducible) | §9.1 fixed seed, deterministic enumeration |
| AC-VIS-1 (Signale language) | §10 |
| AC-RUN-1 (self-contained; Signale not bundled) | §2 NFR-1, §6, §10 |
| AC-OFF-1 (staff offline state) | §7 queue-and-retry with visible badge |
| AC-OFF-2 (viewer no-signal state) | §8 `NO_SIGNAL` state |
| AC-EVID-1 (device clarity) | §11 phone-evidence manifest format |

## 13. Out of scope (this pass)

- Implementation, `tasks.md`, code, automated tests, and on-phone evidence artifacts. This design stops here; the next pass breaks the work into tasks.
