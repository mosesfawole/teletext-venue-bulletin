# Teletext Venue Bulletin

A local Wi-Fi bulletin for event room changes, inspired by numbered TV teletext pages. An organizer updates a workshop, and an attendee who arrives later can tune to page 201 and see the current room, revision, and timestamp.

## Run locally

Requires Node.js 18 or newer. No dependency installation is needed.

1. Set STAFF_SECRET in your shell to a unique password for this demo.
2. Run npm start.
3. Open http://127.0.0.1:8080/staff/ and sign in with that password.
4. Move workshop W7 to Room B. Open http://127.0.0.1:8080/ in a fresh tab and tune to page 201.

For a phone trial on trusted Wi-Fi, set HOST to your computer's Wi-Fi IPv4 address before starting. Open that address on port 8080 from the phone. This prototype uses HTTP and in-memory state. Keep the staff password unique to the demo and use a trusted LAN.

Run npm test for the staff and late-join integration check, and npm run bench to reproduce the scheduling comparison.

## Evidence

The live browser and a physical phone displayed Room B, revision R4, on the same Wi-Fi network. A full internet-outage trial was not verified. The automated integration check verifies that unauthenticated edits fail and that a fresh subscriber sees the updated revision in a carousel slot.

The deterministic comparison uses one equal-sized simulated slot per second in both modes and enumerates every join phase. The fixed cycle has a four-second maximum wait for each page. Priority makes page 201 available in at most two seconds and increases routine-page maximum waits to six seconds. These are modeled scheduling waits, not measured network latency.

## How Kiro was used

Kiro IDE drafted the requirements and design under .kiro/specs/teletext-bulletin, then generated the core modules, HTTP server, and attendee and staff screens. The scheduling requirement was corrected between requirements and design to hold the transmission rate constant. Codex assisted with the comparison, integration check, and demo setup. A separate earlier feasibility prototype was used to validate the concept.

Visual reference: https://www.framer.com/marketplace/templates/signale/
