# Teletext Venue Bulletin — Feature Spec (Requirements)

> Status: **Requirements drafted.** Design and tasks are intentionally out of scope for this pass — this file defines *what* the prototype must do and how it will be judged, not *how* it is built.

## 1. Purpose

Build a self-contained **Teletext venue bulletin** prototype for the **Kiroween Resurrection** event. The bulletin behaves like classic broadcast teletext: numbered pages are transmitted on a cyclic carousel, and a viewer that "tunes in" late must wait for the page it wants to come around, then render it with its latest revision and timestamp.

The first workflow we formalize is the anchor scenario from the build brief:

> A staff organizer moves a workshop to **Room B**. A late attendee opens numbered **page 201** on a phone connected to the venue LAN and sees the latest **room, revision and timestamp**.

## 2. Visual reference — Signale (Framer)

Reference template: [Signale — Free Website Template for Framer](https://www.framer.com/marketplace/templates/signale/).

Signale is a dark, technical, monospace-labeled template built to read like an "event dossier" for multi-day conferences — date, venue and ticket tier sit in a quiet row, with a red/blue glow backdrop and no clutter. We borrow the **language**, not the asset:

- **Dark palette** — near-black surface, hairline borders, restrained accent glow.
- **Monospaced labels** — page numbers, revision counters, timestamps, slot indicators all set in monospace.
- **Event hierarchy** — event name → date/venue → page index → page content, mirroring Signale's dossier reading order.
- **No paid/external assets** — Signale is reference-only. The prototype must not bundle, fetch, or depend on the Framer template, its fonts, or any paid service.

## 3. Scope

**In scope (this spec):**
- The content, addressing and transmission model for a teletext-style bulletin.
- The staff authoring surface (edit a workshop's room).
- The public viewer surface (tune to page 201, see room/revision/timestamp).
- Connection/unavailable status for both audiences.
- A deterministic simulation comparing **fixed** vs **priority** page cycles at **equal transmission bandwidth** across **all join phases**, reporting urgent- and routine-page wait.
- Acceptance criteria for late join, stale revisions, and bounded waits.

**Out of scope (later passes):**
- Implementation, design architecture, task breakdown, code, tests, and the on-phone evidence log. These belong to the `design.md` / `tasks.md` passes that follow requirements sign-off.
- Real RF/teletext hardware; the "transmission" is a simulated slot stream over the venue LAN, not broadcast video.

## 4. The anchor workflow

This single workflow is the spine of the spec. Every requirement traces back to it.

1. **Event is live.** The Kiroween Resurrection bulletin is broadcasting on the venue LAN. Page **201** is the **Workshops** page; it currently lists workshop "W7 — Latent Diffusion Drift" in **Hall A**, at revision `R3`, timestamped `T3`.
2. **Staff edits.** An organizer opens the **staff authoring surface**, changes W7's room from Hall A to **Room B**, and commits. Page 201 advances to revision `R4` with a new timestamp `T4`. The edit is queued/broadcast onto the carousel.
3. **Late attendee joins.** A phone that was *not* connected connects to the venue LAN, opens the **public viewer**, and keys in **201**. It joins the carousel at an arbitrary phase (mid-cycle).
4. **Late arrival resolves.** The viewer waits for page 201 to come around, then renders **Room B**, revision **R4**, timestamp **T4** — never silently showing the pre-edit Hall A / R3 as current, and never showing a blank page in the meantime.

This workflow must hold regardless of the join phase, and must hold under both the fixed and the priority cycle (the priority cycle is expected to make the urgent room-change page arrive sooner).

## 5. Functional requirements

### FR-1 Content model
- **FR-1.1** The bulletin is a set of numbered pages with 3-digit addresses. Page **201** is the Workshops page and is the page under test. A minimal live page set is defined (index 100, workshops 201, schedule 301, status 500) so the carousel is non-trivial.
- **FR-1.2** Each page carries: page number, **revision counter** (monotonic integer per page), **timestamp** (UTC + venue-local), and a structured payload. Page 201's payload includes per-workshop: id, title, room, and schedule slot.
- **FR-1.3** Editing any field on a page increments that page's revision and updates its timestamp. Other pages are unaffected (revisions are per-page).

### FR-2 Transmission / carousel model
- **FR-2.1** A "transmitter" emits pages in discrete **slots**; one slot carries exactly one page's current revision. The sequence of slots is the **cycle**.
- **FR-2.2** A viewer "tunes" to a page number and listens to the slot stream; it renders the page the first time its number appears in a slot after the viewer joined.
- **FR-2.3** **Fixed cycle:** pages are emitted round-robin, each page exactly once per cycle. Cycle length = number of pages `N` slots.
- **FR-2.4** Priority schedule [201, 200, 201, 202, 201, 203]. Fixed schedule [200, 201, 202, 203]. Both emit one equal-sized slot per second.
- **FR-2.5** "Join phase" is the slot offset within the cycle at which a viewer starts listening. The system is evaluated across **all** join phases, not a single cherry-picked one.

### FR-3 Staff authoring surface (separate from public)
- **FR-3.1** Staff access is **separated** from the public viewer — different entry point and different privileges; the public viewer cannot edit.
- **FR-3.2** Staff can edit a workshop's room (the anchor action) and commit, which bumps revision/timestamp and feeds the carousel.
- **FR-3.3** Staff see a **clear status when the connection is unavailable**: edits must not be silently lost. The surface either queues the commit for transmission on reconnect or explicitly warns it is unsaved. (Exact mechanism is a design decision.)

### FR-4 Public viewer surface (the phone)
- **FR-4.1** The viewer lets a phone on the venue LAN enter a page number (201 in the anchor workflow) and renders the page once received.
- **FR-4.2** The viewer always renders the **revision and timestamp** of the page it is currently showing, so any stale page is *identifiable*, not hidden.
- **FR-4.3** The viewer shows a **clear "no signal" status** when no page can be received, distinct from a blank page (teletext-style "tuning…"/"no signal" indicator).
- **FR-4.4** If the connection drops mid-update, the viewer marks the displayed page with its last-known revision and a stale/disconnected indicator rather than presenting cached content as live.

## 6. Non-functional requirements

- **NFR-1 Self-contained runtime.** No paid service, no external network assets. All fonts, images, and logic run locally. Signale is reference-only and is **not** bundled or fetched.
- **NFR-2 Visual language (Signale).** Dark palette, monospace labels for page numbers/revisions/timestamps/slots, and the event-hierarchy reading order (event → date/venue → index → page) per §2.
- **NFR-3 Deterministic simulation.** The scheduling comparison is reproducible from a fixed seed; re-running yields identical numbers.
- **NFR-4 Evidence & device clarity.** The repo keeps evidence of actual Kiro work and clearly marks **which checks ran on a real phone** versus which ran in the simulator. (Evidence artifacts are produced in later passes; this requirement fixes the obligation now.)

## 7. Scheduling comparison — fixed vs priority

The brief requires comparing **fixed** and **priority** page cycles using **equal transmission slots** and **all join phases**, and reporting **urgent page wait** and **routine page wait** as simulated values.

Definitions used by the comparison:
- **Wait** = number of slots from the viewer's join slot to the first slot carrying the requested page's current revision.
- **Urgent page** = page 201 (the room-change page) in the anchor workflow.
- **Routine page** = any non-urgent page in the live set.
- **Mean wait** is averaged uniformly over **all join phases** of the cycle (steady-state fair comparison), for each (scheme × page class) pair.
- **Equal bandwidth** means one equal-sized simulated slot per second in both schedules. Cycle lengths may differ. This measures scheduling delay, independent of real network throughput.

The comparison must report a small table:

| Scheme   | Urgent-page mean wait (slots) | Routine-page mean wait (slots) |
|----------|-------------------------------|--------------------------------|
| Fixed    | _simulated_                   | _simulated_                    |
| Priority | _simulated_                   | _simulated_                    |

The priority scheme is *expected* to lower the urgent-page wait at equal bandwidth, at the cost of raising the routine-page wait; the report must state both numbers honestly, not only the favorable one.

## 8. Acceptance criteria

These are the repeatable checks the prototype must pass. Each is phrased so it can be re-run and pass/fail without judgment.

### 8.1 Late arrivals (anchor workflow)
- **AC-LATE-1 — Late join shows the new room.** After staff commits the Room B edit (page 201 → `R4`/`T4`), a viewer that first connects at *any* join phase and requests page 201 renders **Room B**, revision **R4**, timestamp **T4** within at most **one full cycle** of slots. It must never render the pre-edit Hall A as current.
- **AC-LATE-2 — No blank while tuning.** A late-joining viewer never shows a blank page 201 while the bulletin is live; before the page is received it shows a "tuning…" status and resolves to real content within the bound of AC-LATE-1.
- **AC-LATE-3 — Phase-independence.** AC-LATE-1 holds for every sampled join phase in the simulation, not just a favorable one.

### 8.2 Stale revisions
- **AC-STALE-1 — Revision is always visible.** The public viewer always renders the revision number and timestamp of the page it is showing, so a stale page is identifiable on screen.
- **AC-STALE-2 — No silent staleness.** Once `R_new` has been broadcast in the cycle a viewer is listening to, the viewer replaces any older revision of the same page within the AC-LATE-1 bound; it must not persistently show `R_old` labelled as current.
- **AC-STALE-3 — Disconnection is marked.** If the connection drops mid-update, the viewer marks the displayed page with its last-known revision and a "stale / disconnected" indicator; it does not present cached content as live.

### 8.3 Equal-bandwidth scheduling comparison & bounded waits
- **AC-SCHED-1 — Equal bandwidth.** Use the same pages, slot size and one-second slot duration in both schedules.
- **AC-SCHED-2 — All join phases.** Mean waits are averaged uniformly over all join phases of the cycle for both schemes and both page classes.
- **AC-SCHED-3 — Honest report.** The report states **both** urgent-page and routine-page mean waits for **both** schemes; it does not report only the number that favors priority.
- **AC-SCHED-4 — Bounded waits.** Across every join phase, page 201 waits at most two seconds under priority scheduling and each routine page at most six seconds. The fixed baseline is four seconds maximum for each page.
- **AC-SCHED-5 — Reproducible.** Re-running the comparison with the fixed seed yields identical reported values.

### 8.4 Cross-cutting
- **AC-VIS-1 — Signale language.** Dark palette, monospace labels for page number/revision/timestamp/slot, and event-hierarchy reading order per §2.
- **AC-RUN-1 — Self-contained.** The prototype runs with no paid service and no external network assets; Signale is not bundled or fetched.
- **AC-OFF-1 — Staff offline state.** The staff surface shows a clear offline/unsaved state when the connection is unavailable and does not silently lose an edit.
- **AC-OFF-2 — Viewer no-signal state.** The public viewer shows a distinct "no signal" status when no page can be received (not a blank page).
- **AC-EVID-1 — Device-clarity.** Evidence of Kiro work is kept in the repo, and every check is clearly marked as run on a **real phone** or in the **simulator**.

## 9. Open questions (to resolve in design)

1. **Transport over the venue LAN.** Concretely what carries the "slot stream" (e.g. a local WebSocket fan-out, UDP multicast, or a polled REST endpoint that simulates slots)? Affects NFR-1 and the offline states.
3. **Phone-evidence format.** How "ran on a real phone" evidence is captured and stored (screenshots, a checked-in log, a manifest). Needed to satisfy AC-EVID-1.
4. **Minimal live page set size.** Confirm the page set (100/201/301/500) is enough to make the carousel meaningful without over-building.

---

*Reference: anchor workflow, scheduling comparison and device-clarity obligation come from `kiro-build-brief.md`. Visual language comes from the Signale Framer template (link in §2), used as reference only — not bundled.*
