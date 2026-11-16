import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/main.js';
import { FIXED_CANONICAL, PRIORITY_CANONICAL } from '../src/schedules.js';
import { measure } from '../sim/benchmark.js';

test('equal-slot schedules prioritize 201 while bounding every other page', () => {
  assert.deepEqual(measure(FIXED_CANONICAL).map(row => row.max), [4, 4, 4, 4]);
  assert.deepEqual(measure(PRIORITY_CANONICAL).map(row => row.max), [6, 2, 6, 6]);
});

test('staff changes room and a fresh viewer receives it in a carousel slot', { timeout: 10000 }, async () => {
  const app = createApp({ secret: 'integration-test-only', slotMs: 100 });
  await app.start('127.0.0.1', 0);
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const post = (path, body, cookie) => fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
  try {
    for (const path of ['/', '/staff/', '/viewer.js', '/staff/staff.js']) {
      const response = await fetch(base + path);
      assert.equal(response.status, 200, path);
      assert.ok((await response.text()).length > 0);
    }
    const edit = { page: 201, workshop: 'W7', room: 'Room B' };
    assert.equal((await post('/api/staff/edit', edit)).status, 401);
    const login = await post('/api/staff/login', { password: 'integration-test-only' });
    assert.equal(login.status, 200);
    const cookie = login.headers.get('set-cookie').split(';')[0];
    const response = await post('/api/staff/edit', edit, cookie);
    assert.equal(response.status, 200);
    const saved = await response.json();
    const stream = await fetch(base + '/api/stream', { signal: AbortSignal.timeout(5000) });
    const reader = stream.body.pipeThrough(new TextDecoderStream()).getReader();
    try {
      let pending = '';
      while (true) {
        const next = await reader.read();
        assert.equal(next.done, false);
        pending += next.value;
        const events = pending.split('\n\n');
        pending = events.pop();
        const frames = events.filter(event => event.startsWith('data: '));
        const workshop = frames.map(event => JSON.parse(event.slice(6)).page).find(page => page?.num === 201);
        if (!workshop) continue;
        assert.equal(workshop.rev, saved.rev);
        assert.equal(workshop.payload.workshops.find(item => item.id === 'W7').room, 'Room B');
        break;
      }
    } finally {
      await reader.cancel();
    }
  } finally {
    await app.stop();
  }
});
