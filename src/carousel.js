// src/carousel.js
// The ticker (FR-2). It advances a pointer through the active schedule and
// emits one slot per step, carrying the page's *current* revision read from the
// store at emit time. Slots are pushed to every SSE subscriber; the 1 Hz
// cadence doubles as the connection heartbeat (design §6).

import { liveSchedule } from './schedules.js';

export function createCarousel({ store, schedule = 'priority', autoStart = false, slotMs = 1000 } = {}) {
  let name = schedule;
  let sequence = liveSchedule(name);
  let pointer = 0;
  let slotCounter = 0;
  let timer = null;
  const subscribers = new Set();

  function buildSlot() {
    const num = sequence[pointer];
    const page = store.getPage(num);
    return {
      slot: slotCounter,
      schedule: name,
      page: page
        ? { num: page.number, rev: page.revision, ts: page.timestamp, title: page.title, payload: page.payload }
        : { num, rev: null, ts: null, title: null, payload: null },
    };
  }

  function emit() {
    const slot = buildSlot();
    slotCounter += 1;
    pointer = (pointer + 1) % sequence.length;

    for (const res of [...subscribers]) {
      if (res.writableEnded || res.destroyed) {
        subscribers.delete(res);
        continue;
      }
      try {
        res.write(`data: ${JSON.stringify(slot)}\n\n`);
      } catch {
        subscribers.delete(res);
      }
    }
    return slot;
  }

  function subscribe(res) {
    subscribers.add(res);
    return () => subscribers.delete(res);
  }

  function setSchedule(next) {
    name = next;
    sequence = liveSchedule(name);
    pointer = 0;
  }

  function start() {
    if (!timer) timer = setInterval(emit, slotMs);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  function status() {
    return {
      schedule: name,
      slot: slotCounter,
      pointer,
      subscribers: subscribers.size,
      pages: sequence.length,
    };
  }

  if (autoStart) start();

  return {
    emit,
    step: emit, // alias for clarity in tests / manual stepping
    subscribe,
    setSchedule,
    start,
    stop,
    status,
    get subscribers() {
      return subscribers;
    },
  };
}
