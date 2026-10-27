// -----------------------------------------------------------------------------
// The real clock (performance.now, setTimeout) sped up 20 times, the real
// network (a local HTTP server of the kit serving the fake pump) and the real
// HTTP client: the polls come at the interval, measured; a stop goes through.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { httpServer, measurePeriod, realClock, reply, spyOn } from './kit/index.mjs';
import { WaterkotteApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { createMemoryStore } from '../src/store.js';
import { PASSWORD, fakePump } from './fixtures/fakePump.js';

test('real clock x20: one read per interval (30 s), a stop written and read back', async (t) => {
  const clock = realClock({ speed: 20 });
  const pump = fakePump({ clock });
  const route = (request) => {
    const { status, body, headers } = pump.handle(request.url, request.headers);
    return reply(status, body, headers);
  };
  const server = await httpServer({
    routes: {
      '/cgi/login': route,
      '/cgi/readTags': route,
      '/cgi/writeTags': route,
      '/cgi/logout': route,
    },
  });
  const gladys = createFakeGladys({
    config: { address: `127.0.0.1:${server.port}`, password: PASSWORD, poll_interval: 30 },
  });
  const app = new WaterkotteApp({
    gladys,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store: createMemoryStore(),
  });
  registerHandlers(gladys, app);
  t.after(async () => {
    await app.close();
    clock.close();
    await server.close();
  });
  const spy = spyOn(app, 'poll', clock);
  await gladys.connect();
  await measurePeriod(spy, { count: 3, period: 30_000 });
  assert.equal(pump.count(/login/), 1);

  for (const d of gladys.fake.discoveredDevices) {
    await gladys.fake.deviceCreated(d);
  }
  const d = gladys.fake.devices[0];
  const target = d.features.find((f) => f.external_id.endsWith(':heating-mode'));
  assert.deepEqual(await gladys.fake.setValue(d, target, 'off'), { success: true });
  assert.equal(pump.tags.I30, '0');
});
