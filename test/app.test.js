// -----------------------------------------------------------------------------
// End to end: the real SDK wiring against the SDK's fake Gladys and the
// in-memory fake pump, on the kit's test clock (it moves at every read).
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testClock } from './kit/index.mjs';
import { ACTIONS, MINUTE, SECOND } from '../src/constants.js';
import { createMemoryStore } from '../src/store.js';
import { fakePump } from './fixtures/fakePump.js';
import {
  ALLOWED,
  CONFIG,
  DEVICE,
  PASSWORD,
  feature,
  last,
  message,
  setup,
} from './helpers/setup.js';

const paths = (pump) => pump.requests.map((r) => r.path);
const writes = (pump) => pump.writes().map((r) => `${r.query.t1}=${r.query.v1}`);

/** Counts the connections open at once (`peak`); installed before setup (the app keeps `connect`). */
function trackOpen(pump) {
  const seen = { open: 0, peak: 0 };
  const connect = pump.connect;
  pump.connect = () => {
    const s = connect();
    seen.open += 1;
    seen.peak = Math.max(seen.peak, seen.open);
    const destroy = s.destroy;
    let closed = false;
    s.destroy = () => {
      if (!closed) {
        closed = true;
        seen.open -= 1;
      }
      destroy();
    };
    return s;
  };
  return seen;
}

test('without an address or a password, the status asks for it and nothing is requested', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { gladys } = await setup(t, { config: { address: '192.168.1.50' }, pump, clock });
  assert.equal(pump.connects, 0);
  assert.match(message(gladys).fr, /mot de passe/);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.en, /password/);
  assert.equal(pump.connects, 0);
});

test('one login, then every poll reuses the session, at the interval', async (t) => {
  const { gladys, pump, advance } = await setup(t, { create: false });
  assert.deepEqual(paths(pump), ['/cgi/login', '/cgi/readTags']);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /Connecté : EcoTouch \(série 1012-34567\)/);
  await advance(59 * SECOND);
  assert.equal(pump.count(/readTags/), 1);
  await advance(2 * SECOND);
  assert.equal(pump.count(/readTags/), 2);
  assert.equal(pump.count(/login/), 1);
  // One request at a time, never pipelined: one connection per request.
  assert.equal(pump.connects, pump.requests.length);
});

test('the device: features read, no switch nor writable binary, options are strings', async (t) => {
  const { gladys } = await setup(t, { create: false });
  const d = gladys.fake.discoveredDevices[0];
  assert.equal(d.external_id, DEVICE);
  assert.deepEqual(d.params, [
    { name: 'system', value: 'ecotouch' },
    { name: 'serial', value: '1012-34567' },
  ]);
  const roles = d.features.map((f) => f.external_id.slice(DEVICE.length + 1));
  assert.ok(!roles.includes('temperature-room'), 'a sentinel value is not a sensor');
  assert.ok(roles.includes('heating-mode') && roles.includes('dhw-setpoint'));
  for (const f of d.features) {
    assert.ok(!(f.type === 'binary' && f.read_only === false), f.external_id);
    assert.notEqual(f.category, 'switch');
    for (const option of f.supported_options ?? []) {
      assert.equal(typeof option.label, 'string');
    }
  }
  const setpoint = d.features.find((f) => f.external_id === feature('dhw-setpoint'));
  assert.equal(setpoint.max, 65);
});

test('states: temperatures, modes as their key, compressor and hot water bits', async (t) => {
  const { gladys } = await setup(t);
  assert.equal(last(gladys, 'temperature-outdoor'), 5.2);
  assert.equal(last(gladys, 'dhw-setpoint'), 50);
  assert.equal(last(gladys, 'heating-mode'), 'auto');
  assert.equal(last(gladys, 'compressor'), 1);
  assert.equal(last(gladys, 'dhw-active'), 1);
  assert.equal(last(gladys, 'alarm'), 0);
});

test('a session that expired: one login in the poll, never a loop', async (t) => {
  const { pump, advance, gladys } = await setup(t);
  pump.expire();
  await advance(61 * SECOND);
  assert.equal(pump.count(/login/), 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  // A controller that forgets the session at once: at most one login per poll.
  const handle = pump.handle;
  pump.handle = (path, headers) => {
    const answer = handle(path, headers);
    pump.expire();
    return answer;
  };
  const before = pump.count(/login/);
  await advance(121 * SECOND);
  assert.equal(pump.count(/login/) - before, 1);
  assert.equal(gladys.fake.connectionStatus.connected, false);
});

test('too many sessions: a pause of 1 min, persisted, doubled, nothing asked meanwhile', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock, maxSessions: 0 });
  const store = createMemoryStore();
  const { gladys, advance } = await setup(t, { pump, clock, store, create: false });
  assert.match(message(gladys).fr, /trop de sessions/);
  assert.ok(store.data.pause.until > clock.now());
  const count = pump.requests.length;
  await advance(59 * SECOND);
  assert.equal(pump.requests.length, count);
  await advance(2 * SECOND);
  assert.equal(pump.requests.length, count + 1);
  assert.equal(store.data.pause.length, 2 * MINUTE);
});

test('credentials refused: kept in /data (8 bits, never the password), no automatic retry, lifted by new ones', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock, password: 'other' });
  const store = createMemoryStore();
  const { gladys, advance, logs } = await setup(t, { pump, clock, store, create: false });
  assert.match(message(gladys).fr, /refusé le nom d'utilisateur ou le mot de passe/);
  assert.deepEqual(Object.keys(store.data.refusal).sort(), ['fp', 'salt']);
  assert.doesNotMatch(JSON.stringify(store.data), new RegExp(PASSWORD));
  await advance(10 * MINUTE, SECOND);
  assert.equal(pump.count(/login/), 1);
  // The same credentials again (a restart): still refused, nothing sent.
  await gladys.fake.configUpdated({ ...CONFIG, poll_interval: 90 });
  await advance(5 * SECOND);
  assert.equal(pump.count(/login/), 1);
  // New credentials: tried at once.
  pump.password = 'right';
  await gladys.fake.configUpdated({ ...CONFIG, password: 'right' });
  await advance(SECOND);
  assert.equal(pump.count(/login/), 2);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.equal(store.data.refusal, undefined);
  assert.doesNotMatch(logs.join('\n'), /pump-secret|right/);
});

test('credentials refused: the test button tries once per click and lifts the refusal on success', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock, password: 'other' });
  const { gladys, advance } = await setup(t, { pump, clock, create: false });
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /refusé/);
  assert.equal(pump.count(/login/), 2);
  const again = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(again.data.message.fr, /moins de 10 s/);
  assert.equal(pump.count(/login/), 2);
  pump.password = PASSWORD;
  await advance(11 * SECOND);
  const ok = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  await advance(SECOND);
  assert.match(ok.data.message.fr, /Connecté/);
});

test('the test button never reads sooner than the interval', async (t) => {
  const { gladys, pump } = await setup(t);
  const ack = await gladys.fake.action(ACTIONS.TEST_CONNECTION);
  assert.match(ack.data.message.fr, /prochaine lecture dans/);
  assert.equal(pump.count(/readTags/), 1);
});

test('a restart reads no sooner than the interval after the last attempt kept in /data', async (t) => {
  const clock = testClock();
  const store = createMemoryStore({ lastAttemptAt: clock.now() - 20 * SECOND });
  const pump = fakePump({ clock });
  const { advance } = await setup(t, { pump, clock, store, create: false });
  assert.equal(pump.count(/readTags/), 0);
  await advance(39 * SECOND);
  assert.equal(pump.count(/readTags/), 0);
  await advance(2 * SECOND);
  assert.equal(pump.count(/readTags/), 1);
  // A date in the future is invalid.
  const later = createMemoryStore({ lastAttemptAt: clock.now() + 10 * MINUTE });
  const pump2 = fakePump({ clock });
  await setup(t, { pump: pump2, clock, store: later, create: false });
  assert.equal(pump2.count(/readTags/), 1);
});

test('Gladys reconnects: status and states again, no new read', async (t) => {
  const { gladys, pump, app } = await setup(t);
  const reads = pump.count(/readTags/);
  await app.connected(async () => CONFIG);
  assert.equal(pump.count(/readTags/), reads);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('getConfig failing: retried every 30 s with a status, without end', async (t) => {
  const { app, gladys, advance } = await setup(t, { connectGladys: false });
  await gladys.connect();
  let calls = 0;
  await app.connected(async () => {
    calls += 1;
    throw new Error('down');
  });
  assert.match(message(gladys).fr, /Configuration non lue/);
  await advance(61 * SECOND, SECOND);
  assert.equal(calls, 3);
});

test('getConfig failing once after a reconnection: retried 30 s later, then applied, same client', async (t) => {
  const { app, gladys, pump, advance } = await setup(t);
  let calls = 0;
  await app.connected(async () => {
    calls += 1;
    if (calls === 1) {
      throw new Error('down');
    }
    return ALLOWED;
  });
  assert.match(message(gladys).fr, /Configuration non lue/);
  assert.equal(app.config.allowCommands, false);
  await advance(31 * SECOND, SECOND);
  assert.equal(calls, 2);
  assert.equal(app.config.allowCommands, true);
  assert.equal(gladys.fake.connectionStatus.connected, true);
  assert.match(message(gladys).fr, /Connecté/);
  assert.equal(pump.count(/login/), 1);
});

test('an oversized answer is cut, the poll fails and backs off', async (t) => {
  const { gladys, pump, advance } = await setup(t);
  pump.bigBody = 100 * 1024;
  await advance(61 * SECOND);
  assert.equal(gladys.fake.connectionStatus.connected, false);
  assert.match(message(gladys).fr, /réponse trop grande/);
});

// --- Stops ----------------------------------------------------------------------------

test('Off goes with the commands disabled, read back, success', async (t) => {
  const { pump, command, gladys } = await setup(t);
  const ack = await command('heating-mode', 'off');
  assert.deepEqual(ack, { success: true });
  assert.deepEqual(writes(pump), ['I30=0']);
  assert.equal(pump.tags.I30, '0');
  assert.equal(last(gladys, 'heating-mode'), 'off');
});

test('Off goes during a pause, before a first read, and while a poll is frozen (cut after 1 s)', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { command, advance, app } = await setup(t, { pump, clock });
  // A frozen poll read.
  pump.silent = /readTags/;
  await advance(60 * SECOND);
  assert.ok(app.running, 'a poll is in flight');
  pump.silent = undefined;
  const started = clock.monotonic();
  const ack = await command('dhw-mode', 'off', { wait: 3500 });
  assert.deepEqual(ack, { success: true });
  assert.ok(clock.monotonic() - started <= 3600);
  assert.equal(pump.tags.I32, '0');
  // During a pause.
  app.pause = { due: clock.monotonic() + 10 * MINUTE, length: MINUTE, kind: 'tooManyUsers' };
  pump.tags.I32 = '1';
  assert.deepEqual(await command('dhw-mode', 'off'), { success: true });
  assert.equal(pump.tags.I32, '0');
});

test('Off not applied: kept in /data, written again by the next reads, 3 times at most', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const store = createMemoryStore();
  const { command, advance } = await setup(t, { pump, clock, store });
  pump.applyDelay = Infinity;
  const ack = await command('heating-mode', 'off');
  assert.equal(ack.success, false);
  assert.match(ack.error, /pas encore appliqué/);
  assert.equal(store.data.stops.length, 1);
  assert.equal(store.data.stops[0].role, 'heating-mode');
  await advance(5 * MINUTE, SECOND);
  // 1 + 3 writes, then dropped.
  assert.deepEqual(writes(pump), ['I30=0', 'I30=0', 'I30=0', 'I30=0']);
  assert.equal(store.data.stops.length, 0);
});

test('a stop written again is not written over a value someone else set since', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const store = createMemoryStore();
  const { command, advance } = await setup(t, { pump, clock, store });
  pump.applyDelay = Infinity;
  await command('heating-mode', 'off', { wait: 4000 });
  pump.tags.I30 = '2';
  await advance(2 * MINUTE, SECOND);
  assert.deepEqual(writes(pump), ['I30=0']);
  assert.equal(store.data.stops.length, 0);
});

test('a stop kept in /data goes at start, before the first poll; an outdated one is dropped', async (t) => {
  const clock = testClock();
  const now = clock.now();
  const store = createMemoryStore({
    stops: [
      {
        role: 'dhw-mode',
        from: 1,
        at: now - MINUTE,
        deadline: now + 10 * MINUTE,
        written: true,
        sends: 1,
      },
      { role: 'heating-mode', at: now - 20 * MINUTE, deadline: now - MINUTE, sends: 0 },
    ],
  });
  const pump = fakePump({ clock });
  await setup(t, { pump, clock, store, create: false });
  assert.deepEqual(paths(pump).slice(0, 3), ['/cgi/login', '/cgi/readTags', '/cgi/writeTags']);
  assert.deepEqual(writes(pump), ['I32=0']);
  assert.equal(pump.tags.I30, '1');
});

test('Off without configuration: kept, written as soon as the configuration arrives', async (t) => {
  const clock = testClock();
  const store = createMemoryStore();
  const pump = fakePump({ clock });
  const { gladys, command, device } = await setup(t, { pump, clock, store });
  await gladys.fake.configUpdated({});
  const ack = await command('heating-mode', 'off');
  assert.match(ack.error, /pas configurée/);
  assert.equal(store.data.stops.length, 1);
  assert.ok(device());
  await gladys.fake.configUpdated(CONFIG);
  await new Promise((r) => setImmediate(r));
  assert.ok(writes(pump).includes('I30=0'));
});

test('Off with a session that expired: logs in once and writes', async (t) => {
  const { pump, command } = await setup(t);
  pump.expire();
  assert.deepEqual(await command('heating-mode', 'off'), { success: true });
  assert.equal(pump.count(/login/), 2);
  assert.equal(pump.tags.I30, '0');
});

test('an HTTP 401 or 403 of EcoTouch is not a refusal of the credentials', async (t) => {
  const clock = testClock();
  const store = createMemoryStore();
  const pump = fakePump({ clock });
  const { gladys, advance } = await setup(t, { pump, clock, store });
  const handle = pump.handle;
  pump.handle = (path, headers) =>
    path.startsWith('/cgi/readTags') ? { status: 403, body: 'no' } : handle(path, headers);
  await advance(61 * SECOND);
  assert.equal(store.data.refusal, undefined);
  assert.match(message(gladys).fr, /statut HTTP inattendu/);
});

test('a lost session answered with HTTP 500 + #E_NEED_LOGIN: one login, never a pause (poll and Off)', async (t) => {
  const { pump, command, advance, gladys, app } = await setup(t);
  pump.needLoginStatus = 500;
  pump.expire();
  assert.deepEqual(await command('heating-mode', 'off', { wait: 3000 }), { success: true });
  assert.equal(pump.tags.I30, '0');
  pump.expire();
  await advance(61 * SECOND);
  assert.equal(pump.count(/login/), 3);
  assert.equal(app.pause, undefined);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('Off not sent, the value changed before the click: written by the next read, never dropped unwritten', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { command, advance } = await setup(t, { pump, clock });
  pump.tags.I30 = '2';
  pump.refuse = true;
  const ack = await command('heating-mode', 'off', { wait: 3500 });
  assert.match(ack.error, /Arrêt non envoyé/);
  pump.refuse = false;
  await advance(61 * SECOND, SECOND);
  assert.deepEqual(writes(pump), ['I30=0']);
  assert.equal(pump.tags.I30, '0');
});

test('a scene Auto then Off on a slow controller: the older Auto does not cancel the Off', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { gladys, device, advance } = await setup(t, { pump, clock, config: ALLOWED });
  pump.tags.I30 = '2';
  pump.latency = (path) => (path.startsWith('/cgi/writeTags') ? 3300 : 0);
  const d = device();
  const target = d.features.find((f) => f.external_id === feature('heating-mode'));
  const auto = gladys.fake.setValue(d, target, 'auto');
  await advance(100, 50);
  const off = gladys.fake.setValue(d, target, 'off');
  await advance(5000);
  assert.deepEqual(await auto, { success: true });
  // The gate not free in time: "no answer in time", never an ambiguous "too late".
  assert.match((await off).error, /Arrêt non envoyé \(pas de réponse à temps\)/);
  pump.latency = 0;
  await advance(2 * MINUTE, SECOND);
  assert.equal(pump.tags.I30, '0');
});

test('Off written, then an older Auto of Gladys applied late: not "someone else", the stop is written again', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { gladys, device, advance } = await setup(t, { pump, clock, config: ALLOWED });
  pump.tags.I30 = '2';
  // Auto applied 3 s late (after the Off was read back); the first Off is lost.
  let offs = 0;
  pump.applyDelay = (w) =>
    w.I30 === '1' ? 3 * SECOND : w.I30 === '0' && (offs += 1) === 1 ? Infinity : 0;
  const d = device();
  const target = d.features.find((f) => f.external_id === feature('heating-mode'));
  const auto = gladys.fake.setValue(d, target, 'auto');
  await advance(100, 50);
  const off = gladys.fake.setValue(d, target, 'off');
  await advance(2500);
  assert.match((await auto).error, /pas encore appliquée/);
  assert.match((await off).error, /pas encore appliqué/);
  await advance(2 * MINUTE, SECOND);
  assert.equal(pump.tags.I30, '0');
});

test('a stop arriving during a round of kept stops is not judged on the round read', async (t) => {
  const clock = testClock();
  const now = clock.now();
  const store = createMemoryStore({
    stops: [
      { role: 'heating-mode', from: 1, at: now - MINUTE, deadline: now + 10 * MINUTE, sends: 0 },
    ],
  });
  const pump = fakePump({ clock });
  pump.latency = (path) => (path.startsWith('/cgi/readTags') ? 600 : 0);
  const { gladys, advance } = await setup(t, {
    pump,
    clock,
    store,
    create: false,
    connectGladys: false,
  });
  await gladys.connect();
  await advance(300, 50);
  const d = { external_id: DEVICE, features: [{ external_id: feature('dhw-mode') }] };
  const off = gladys.fake.setValue(d, d.features[0], 'off');
  await advance(4000, 50);
  assert.deepEqual(await off, { success: true });
  const dhwWrites = pump.writes().filter((r) => Object.values(r.query).includes('I32')).length;
  assert.equal(dhwWrites, 1);
});

test('a controller busy for 10 min during a pause: the Off is written before its deadline', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock, maxSessions: 2 });
  const { gladys, device, advance, app } = await setup(t, { pump, clock });
  pump.expire();
  pump.sessions.add('browser');
  pump.sessions.add('app');
  app.lastReadAt = undefined;
  await app.tick();
  assert.ok(app.pauseLeft(clock.monotonic()) > 0);
  const d = device();
  const target = d.features.find((f) => f.external_id === feature('heating-mode'));
  const off = gladys.fake.setValue(d, target, 'off');
  await advance(4000);
  assert.match((await off).error, /Arrêt non envoyé/);
  clock.timers.setTimeout(() => pump.sessions.clear(), 10 * MINUTE);
  await advance(14 * MINUTE, 5 * SECOND);
  assert.deepEqual(writes(pump), ['I30=0']);
  assert.equal(pump.tags.I30, '0');
  assert.ok(pump.count(/login/) <= 20);
});

test('an Off not sent is tried again within 10 to 20 s, not at the next poll', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { command, advance, gladys } = await setup(t, { pump, clock });
  await gladys.fake.configUpdated({ ...CONFIG, poll_interval: 600 });
  await advance(SECOND);
  pump.refuse = true;
  const ack = await command('heating-mode', 'off', { wait: 3500 });
  assert.match(ack.error, /Arrêt non envoyé/);
  pump.refuse = false;
  await advance(15 * SECOND);
  assert.deepEqual(writes(pump), ['I30=0']);
});

test('the configuration saved during a slow logout: the Off goes on the new client only, one connection at a time', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const seen = trackOpen(pump);
  const { gladys, device, advance } = await setup(t, { pump, clock });
  seen.peak = 0;
  pump.latency = (path) => (path.startsWith('/cgi/logout') ? 900 : 0);
  const d = device();
  const target = d.features.find((f) => f.external_id === feature('heating-mode'));
  const saved = gladys.fake.configUpdated({ ...CONFIG, poll_interval: 45 });
  await advance(100, 50);
  const off = gladys.fake.setValue(d, target, 'off');
  await advance(4000, 50);
  await saved;
  assert.deepEqual(await off, { success: true });
  assert.equal(pump.tags.I30, '0');
  assert.equal(seen.peak, 1);
  assert.equal(pump.sessions.size, 1);
});

/**
 * Two saves of the configuration in a row while a poll is in flight (the
 * SDK runs the messages concurrently): the first (interval 45 s) allows the
 * commands, the second (interval `second`), `gap` ms later, forbids them.
 */
async function twoSaves(t, { gap, second }) {
  const clock = testClock();
  const pump = fakePump({ clock });
  const seen = trackOpen(pump);
  const { gladys, app, command, advance } = await setup(t, {
    pump,
    clock,
    config: { ...ALLOWED, poll_interval: 30 },
  });
  pump.tags.I30 = '2';
  pump.latency = (path) => (path.startsWith('/cgi/readTags') ? 2000 : 0);
  app.lastReadAt = undefined;
  app.tick();
  await advance(50, 50);
  const first = app.client;
  seen.peak = 0;
  const saves = [gladys.fake.configUpdated({ ...ALLOWED, poll_interval: 45 })];
  await advance(gap, 50);
  saves.push(gladys.fake.configUpdated({ ...CONFIG, poll_interval: second }));
  await advance(4000, 50);
  await Promise.all(saves);
  pump.latency = 0;
  const ack = await command('heating-mode', 'auto');
  return { ack, app, pump, seen, first };
}

for (const [second, name] of [
  [45, 'the second keeps the new interval'],
  [30, 'the second goes back to the old interval'],
]) {
  test(`two saves in a row during a poll, ${name}: the latest wins, one client`, async (t) => {
    // During the logout of the first client, then once the first restart has its client.
    for (const gap of [100, 1500, 3000]) {
      const { ack, app, pump, seen, first } = await twoSaves(t, { gap, second });
      assert.match(ack.error, /désactivées/, `gap ${gap} ms`);
      assert.equal(pump.writes().length, 0);
      assert.equal(pump.tags.I30, '2');
      assert.equal(app.config.allowCommands, false);
      assert.equal(app.config.pollInterval, second);
      assert.ok(first.closed && !app.client.closed, 'one client alive');
      assert.equal(seen.peak, 1);
      assert.ok(pump.sessions.size <= 1);
    }
  });
}

test('a configuration received during a restart restricts the commands at once', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { gladys, app, device, command, advance } = await setup(t, {
    pump,
    clock,
    config: ALLOWED,
  });
  pump.applyDelay = Infinity;
  // A stop kept: the restart has a stop round, slow.
  await command('heating-mode', 'off', { wait: 3000 });
  pump.latency = (path) => (path.startsWith('/cgi/readTags') ? 1000 : 0);
  const saves = [gladys.fake.configUpdated({ ...ALLOWED, poll_interval: 45 })];
  await advance(300, 50);
  assert.ok(app.client && app.applying, 'the new client runs its first round');
  saves.push(
    gladys.fake.configUpdated({
      ...CONFIG,
      poll_interval: 45,
      dhw_max_temperature: 45,
    }),
  );
  const d = device();
  const answers = [];
  for (const [role, value] of [
    ['heating-mode', 'auto'],
    ['dhw-setpoint', 50],
  ]) {
    const target = d.features.find((f) => f.external_id === feature(role));
    gladys.fake.setValue(d, target, value).then((ack) => answers.push(ack.error));
  }
  await advance(100, 50);
  // Refused before the end of the restart, nothing asked of the controller.
  assert.equal(answers.length, 2);
  assert.match(answers.join(' '), /désactivées/);
  assert.match(answers.join(' '), /plafond d'eau chaude de 45/);
  await advance(3000, 50);
  await Promise.all(saves);
  assert.equal(app.config.allowCommands, false);
  assert.equal(app.config.dhwCap, 45);
  assert.ok(pump.writes().every((r) => r.query.t1 === 'I30'));
});

test('Gladys reconnects while the configuration is saved: the save wins over the older answer', async (t) => {
  const clock = testClock();
  const { app, gladys, advance } = await setup(t, { clock, config: ALLOWED });
  const reconnected = app.connected(
    () => new Promise((resolve) => clock.timers.setTimeout(() => resolve(ALLOWED), 1000)),
  );
  await advance(100, 50);
  await gladys.fake.configUpdated(CONFIG);
  await advance(1000, 50);
  await reconnected;
  assert.equal(app.config.allowCommands, false);
  assert.equal(gladys.fake.connectionStatus.connected, true);
});

test('Off clicked while a configuration without an address is applied: "not configured", kept', async (t) => {
  const clock = testClock();
  const store = createMemoryStore();
  const pump = fakePump({ clock });
  const { gladys, device, advance } = await setup(t, { pump, clock, store });
  pump.latency = (path) => (path.startsWith('/cgi/logout') ? 900 : 0);
  const saved = gladys.fake.configUpdated({ password: PASSWORD });
  await advance(100, 50);
  const d = device();
  const target = d.features.find((f) => f.external_id === feature('heating-mode'));
  const off = gladys.fake.setValue(d, target, 'off');
  await advance(4000, 50);
  await saved;
  assert.match((await off).error, /pas configurée/);
  assert.equal(store.data.stops.length, 1);
  assert.equal(pump.writes().length, 0);
});

test('Off clicked while the configuration switches to EasyCon: refused (read only), not kept', async (t) => {
  const clock = testClock();
  const store = createMemoryStore();
  const pump = fakePump({ clock });
  const { gladys, device, advance } = await setup(t, { pump, clock, store });
  pump.latency = (path) => (path.startsWith('/cgi/logout') ? 900 : 0);
  const saved = gladys.fake.configUpdated({ ...CONFIG, system: 'easycon' });
  await advance(100, 50);
  const d = device();
  const target = d.features.find((f) => f.external_id === feature('heating-mode'));
  const off = gladys.fake.setValue(d, target, 'off');
  await advance(4000, 50);
  await saved;
  assert.match((await off).error, /EasyCon est en lecture seule/);
  assert.equal(store.data.stops.length, 0);
  assert.equal(pump.writes().length, 0);
});

test('Off during a restart, written by the first round of the new client: its read back answers', async (t) => {
  for (const [read, expected] of [
    [2500, undefined],
    [4500, /Arrêt envoyé, sans confirmation \(pas de réponse à temps\)/],
  ]) {
    const clock = testClock();
    const pump = fakePump({ clock });
    const { gladys, app, device, advance } = await setup(t, { pump, clock });
    pump.latency = (path) =>
      path.startsWith('/cgi/readTags') ? read : path.startsWith('/cgi/logout') ? 700 : 0;
    app.lastReadAt = undefined;
    app.tick();
    await advance(50, 50);
    const saved = gladys.fake.configUpdated({ ...CONFIG, poll_interval: 45 });
    // The poll ends, the logout of the old session starts.
    await advance(read + 100, 50);
    const d = device();
    const target = d.features.find((f) => f.external_id === feature('heating-mode'));
    const off = gladys.fake.setValue(d, target, 'off');
    // The round's read back ends 5.1 s after the click at most.
    await advance(6000, 50);
    await saved;
    const ack = await off;
    if (expected) {
      assert.match(ack.error, expected);
    } else {
      assert.deepEqual(ack, { success: true });
    }
    // Written once, by the round of the new client.
    assert.deepEqual(writes(pump), ['I30=0']);
    assert.equal(pump.tags.I30, '0');
  }
});

test('shut down during a restart: no new client, every session ended, nothing runs after', async (t) => {
  // During the logout of the previous client.
  const clock = testClock();
  const pump = fakePump({ clock });
  const { gladys, app, advance } = await setup(t, { pump, clock });
  pump.latency = (path) => (path.startsWith('/cgi/logout') ? 900 : 0);
  const saved = gladys.fake.configUpdated({ ...CONFIG, poll_interval: 45 });
  await advance(100, 50);
  let done = false;
  const closed = app.close().then(() => {
    done = true;
  });
  await advance(300, 50);
  assert.equal(done, false, 'the shutdown waits for the logout in flight');
  await advance(2000, 50);
  await closed;
  await saved;
  assert.equal(app.client, undefined);
  assert.equal(pump.sessions.size, 0);
  assert.equal(pump.count(/login/), 1);
  const requests = pump.requests.length;
  await advance(5 * MINUTE, 10 * SECOND);
  assert.equal(pump.requests.length, requests);
  assert.equal(clock.pending, 0, 'no timer left');

  // During the login of the new client (its first stop round): that session is ended too.
  const clock2 = testClock();
  const pump2 = fakePump({ clock: clock2 });
  const second = await setup(t, { pump: pump2, clock: clock2 });
  pump2.applyDelay = Infinity;
  await second.command('heating-mode', 'off', { wait: 3000 });
  pump2.early = /login/;
  pump2.latency = (path) => (path.startsWith('/cgi/login') ? 500 : 0);
  const saved2 = second.gladys.fake.configUpdated({ ...CONFIG, poll_interval: 45 });
  await second.advance(200, 50);
  assert.equal(pump2.sessions.size, 1, 'the new login reached the controller');
  const closed2 = second.app.close();
  await second.advance(3000, 50);
  await closed2;
  await saved2;
  assert.equal(pump2.sessions.size, 0);
  const after = pump2.requests.length;
  await second.advance(5 * MINUTE, 10 * SECOND);
  assert.equal(pump2.requests.length, after);
  assert.equal(clock2.pending, 0, 'no timer left');
});

test('a kept stop: the write meets "#E_NEED_LOGIN" then the login "too many users": not counted, written later', async (t) => {
  const clock = testClock();
  const store = createMemoryStore();
  const pump = fakePump({ clock, maxSessions: 3 });
  const { command, advance } = await setup(t, { pump, clock, store });
  pump.applyDelay = Infinity;
  await command('heating-mode', 'off', { wait: 3000 });
  assert.equal(store.data.stops[0].sends, 0);
  let armed = 1;
  const handle = pump.handle;
  pump.handle = (path, headers) => {
    if (armed > 0 && path.startsWith('/cgi/writeTags')) {
      armed -= 1;
      pump.sessions.clear();
      pump.sessions.add('a');
      pump.sessions.add('b');
      pump.sessions.add('c');
      return { status: 200, body: '#E_NEED_LOGIN\n' };
    }
    return handle(path, headers);
  };
  await advance(18 * SECOND);
  assert.equal(store.data.stops[0].sends, 0, 'a write that met a refused login is not counted');
  pump.sessions.clear();
  pump.applyDelay = 0;
  await advance(2 * MINUTE, SECOND);
  assert.equal(pump.tags.I30, '0');
});

test('Off without a session and the network down for 0.5 s: logs in and writes within its budget', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { gladys, device, advance, app } = await setup(t, { pump, clock });
  app.client.cookie = undefined;
  pump.refuse = true;
  const d = device();
  const target = d.features.find((f) => f.external_id === feature('heating-mode'));
  const ack = gladys.fake.setValue(d, target, 'off');
  await advance(500, 50);
  pump.refuse = false;
  await advance(3000);
  assert.deepEqual(await ack, { success: true });
});

test('a login refused "too many users" during an Off: "not sent", and not counted as a write', async (t) => {
  const clock = testClock();
  const store = createMemoryStore();
  const pump = fakePump({ clock, maxSessions: 1 });
  const { command } = await setup(t, { pump, clock, store });
  pump.expire();
  pump.sessions.add('browser');
  const ack = await command('heating-mode', 'off', { wait: 3500 });
  assert.match(ack.error, /Arrêt non envoyé \(trop de sessions\)/);
  // The write met "#E_NEED_LOGIN" (nothing applied), then the login was refused.
  assert.equal(pump.tags.I30, '1');
  assert.equal(store.data.stops[0].written, false);
});

test('a stop is dropped at its deadline even when every read fails, and the pause is kept', async (t) => {
  const clock = testClock();
  const store = createMemoryStore();
  const pump = fakePump({ clock, maxSessions: 1 });
  const { command, advance } = await setup(t, { pump, clock, store });
  pump.expire();
  pump.sessions.add('browser');
  await command('heating-mode', 'off', { wait: 3500 });
  await advance(16 * MINUTE, 5 * SECOND);
  assert.deepEqual(store.data.stops, []);
  // A stop round a minute at most (15), the pause reads (1, 3, 7, 15 min), the first ones.
  assert.ok(pump.count(/login/) <= 22, String(pump.count(/login/)));
  const logins = pump.count(/login/);
  await advance(60 * MINUTE, 10 * SECOND);
  // Only the reads of the doubled pause (2, 4, 8, 16, 32 min...): a handful, not one a minute.
  assert.ok(pump.count(/login/) - logins <= 3, String(pump.count(/login/) - logins));
});

test('the deadline of a stop follows the monotonic clock, not the wall clock', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { command, app } = await setup(t, { pump, clock });
  pump.applyDelay = Infinity;
  await command('heating-mode', 'off', { wait: 3000 });
  const stop = app.stops.get('heating-mode');
  assert.ok(stop.deadlineMono > clock.monotonic());
  assert.equal(stop.deadline, undefined);
});

test('an invalid address is never shown back (it may carry a password)', async (t) => {
  const { gladys } = await setup(t, {
    config: { address: 'http://waterkotte:S3cret@192.168.1.50', password: PASSWORD },
    create: false,
  });
  assert.doesNotMatch(JSON.stringify(message(gladys)), /S3cret/);
  assert.match(message(gladys).fr, /adresse saisie n'est pas valide/);
});

test('Off with refused credentials: nothing sent, the refused password never sent again', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { command, app } = await setup(t, { pump, clock });
  app.refusal = { salt: '00'.repeat(16), fp: 1 };
  const logins = pump.count(/login/);
  const ack = await command('heating-mode', 'off');
  assert.match(ack.error, /refusé les identifiants/);
  assert.equal(pump.count(/login/), logins);
  assert.equal(pump.writes().length, 0);
});

test('Off retries every 250 ms within its budget while the connection is refused', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { gladys, device, advance } = await setup(t, { pump, clock });
  pump.refuse = true;
  const connects = pump.connects;
  const d = device();
  const target = d.features.find((f) => f.external_id === feature('heating-mode'));
  const ack = gladys.fake.setValue(d, target, 'off');
  await advance(1000, 50);
  pump.refuse = false;
  await advance(4000);
  assert.deepEqual(await ack, { success: true });
  assert.ok(pump.connects - connects >= 4);
});

test('a sensitive command clicked before Off never leaves after it', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const { gladys, device, advance } = await setup(t, { pump, clock, config: ALLOWED });
  pump.tags.I30 = '0';
  pump.latency = 400;
  const d = device();
  const target = (role) => d.features.find((f) => f.external_id === feature(role));
  const auto = gladys.fake.setValue(d, target('heating-mode'), 'auto');
  await advance(100, 50);
  const off = gladys.fake.setValue(d, target('heating-mode'), 'off');
  await advance(5000);
  assert.match((await auto).error, /Annulée par un « Arrêt »/);
  assert.deepEqual(await off, { success: true });
  assert.deepEqual(writes(pump), ['I30=0']);
});

test('a newer command that left replaces the stop to resend; one refused does not', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  const store = createMemoryStore();
  const { command, advance, gladys } = await setup(t, { pump, clock, store, config: ALLOWED });
  pump.applyDelay = Infinity;
  await command('heating-mode', 'off');
  assert.equal(store.data.stops.length, 1);
  // Option turned off: the "auto" never leaves, the stop stays.
  await gladys.fake.configUpdated({ ...ALLOWED, allow_commands: false });
  await command('heating-mode', 'auto');
  assert.equal(store.data.stops.length, 1);
  await gladys.fake.configUpdated(ALLOWED);
  pump.applyDelay = 0;
  const ack = await command('heating-mode', 'manual');
  assert.deepEqual(ack, { success: true });
  assert.equal(store.data.stops.length, 0);
  await advance(2 * MINUTE, SECOND);
  assert.equal(pump.tags.I30, '2');
});

// --- Sensitive commands ---------------------------------------------------------------

test('Auto, Manual and the setpoint are refused unless allowed, nothing sent', async (t) => {
  const { command, pump } = await setup(t);
  for (const [role, value] of [
    ['heating-mode', 'auto'],
    ['dhw-mode', 'manual'],
    ['dhw-setpoint', 50],
  ]) {
    const ack = await command(role, value);
    assert.match(ack.error, /désactivées/);
  }
  assert.equal(pump.writes().length, 0);
});

test('the hot water setpoint: whole degrees, 28 to the ceiling (65 by default), never above 65', async (t) => {
  const { command, pump, gladys } = await setup(t, { config: ALLOWED });
  for (const [value, error] of [
    [66, /Entre 28 et 65/],
    [70, /Entre 28 et 65/],
    [65.5, /Entre 28 et 65|Degrés entiers/],
    [27, /Entre 28 et 65/],
    [50.5, /Degrés entiers/],
    ['', /pas un nombre/],
    [null, /pas un nombre/],
    ['1e2', /pas un nombre/],
  ]) {
    const ack = await command('dhw-setpoint', value);
    assert.match(ack.error, error, String(value));
  }
  assert.equal(pump.writes().length, 0);
  assert.deepEqual(await command('dhw-setpoint', 65), { success: true });
  assert.deepEqual(writes(pump), ['A38=650']);
  await gladys.fake.configUpdated({ ...ALLOWED, dhw_max_temperature: 55 });
  assert.match((await command('dhw-setpoint', 56)).error, /plafond d'eau chaude de 55/);
  assert.deepEqual(await command('dhw-setpoint', 55), { success: true });
  await gladys.fake.configUpdated({ ...ALLOWED, dhw_max_temperature: 75 });
  assert.match((await command('dhw-setpoint', 66)).error, /Entre 28 et 65/);
  assert.match((await command('dhw-setpoint', 65.5)).error, /Entre 28 et 65|Degrés entiers/);
  assert.ok(pump.writes().every((r) => Number(r.query.v1) <= 650));
});

test('a value already in place: nothing written', async (t) => {
  const { command, pump } = await setup(t, { config: ALLOWED });
  assert.deepEqual(await command('heating-mode', 'auto'), { success: true });
  assert.equal(pump.writes().length, 0);
});

test('acknowledged but not applied: "not applied yet", follow-up reads, never a success', async (t) => {
  const { command, pump, advance } = await setup(t, { config: ALLOWED });
  pump.applyDelay = Infinity;
  const ack = await command('heating-mode', 'manual', { wait: 4900 });
  assert.match(ack.error, /pas encore appliquée/);
  const reads = pump.count(/readTags/);
  await advance(21 * SECOND);
  assert.equal(pump.count(/readTags/), reads + 2);
});

test('a write without an answer: "sent, without confirmation"; unreachable: "nothing sent"', async (t) => {
  const { command, pump } = await setup(t, { config: ALLOWED });
  pump.silent = /writeTags/;
  const ack = await command('heating-mode', 'manual');
  assert.match(ack.error, /Envoyée, sans confirmation/);
  pump.silent = undefined;
  pump.refuse = true;
  const ack2 = await command('dhw-mode', 'manual');
  assert.match(ack2.error, /Rien envoyé|rien envoyé/);
});

test('the option turned off during the fresh read: nothing sent', async (t) => {
  const { gladys, device, pump, advance } = await setup(t, { config: ALLOWED });
  pump.latency = 500;
  const d = device();
  const target = d.features.find((f) => f.external_id === feature('heating-mode'));
  const ack = gladys.fake.setValue(d, target, 'manual');
  await advance(200, 50);
  await gladys.fake.configUpdated({ ...ALLOWED, allow_commands: false });
  await advance(4000);
  assert.match((await ack).error, /désactivées/);
  assert.equal(pump.writes().length, 0);
});

test('the ceiling lowered during the fresh read: nothing sent', async (t) => {
  const { gladys, device, pump, advance } = await setup(t, { config: ALLOWED });
  pump.latency = 500;
  const d = device();
  const target = d.features.find((f) => f.external_id === feature('dhw-setpoint'));
  const ack = gladys.fake.setValue(d, target, 55);
  await advance(200, 50);
  await gladys.fake.configUpdated({ ...ALLOWED, dhw_max_temperature: 45 });
  await advance(4000);
  assert.match((await ack).error, /plafond d'eau chaude de 45/);
  assert.equal(pump.writes().length, 0);
});

test('/data that cannot be saved or read: the sensitive command is refused, Off still goes', async (t) => {
  const clock = testClock();
  const store = createMemoryStore();
  const pump = fakePump({ clock });
  const { command } = await setup(t, { pump, clock, store, config: ALLOWED });
  store.fail = true;
  assert.match((await command('heating-mode', 'manual')).error, /enregistré dans \/data/);
  assert.equal(pump.writes().length, 0);
  assert.deepEqual(await command('heating-mode', 'off'), { success: true });

  const clock2 = testClock();
  const unreadable = createMemoryStore({}, { readable: false });
  const pump2 = fakePump({ clock: clock2 });
  const second = await setup(t, { pump: pump2, clock: clock2, store: unreadable, config: ALLOWED });
  assert.match((await second.command('heating-mode', 'manual')).error, /illisible/);
  assert.deepEqual(await second.command('heating-mode', 'off'), { success: true });
  assert.equal(unreadable.saves, 0, 'an unreadable /data is never overwritten');
});

test('another heat pump at the address: nothing published, sensitive commands refused, Off still goes', async (t) => {
  const { command, pump, advance, gladys } = await setup(t, { config: ALLOWED });
  pump.tags.I115 = '99999';
  pump.tags.A1 = '-100';
  await advance(61 * SECOND);
  assert.match(message(gladys).fr, /Une autre pompe à chaleur répond/);
  assert.equal(last(gladys, 'temperature-outdoor'), 5.2);
  assert.match((await command('heating-mode', 'manual')).error, /autre pompe à chaleur/);
  assert.deepEqual(await command('heating-mode', 'off'), { success: true });
  delete pump.tags.I115;
  assert.match((await command('dhw-mode', 'manual')).error, /illisible/);
});

test('a scene on the three targets: all set', async (t) => {
  const { gladys, device, pump, advance } = await setup(t, { config: ALLOWED });
  pump.latency = 150;
  const d = device();
  const target = (role) => d.features.find((f) => f.external_id === feature(role));
  const acks = [
    gladys.fake.setValue(d, target('heating-mode'), 'manual'),
    gladys.fake.setValue(d, target('dhw-mode'), 'manual'),
    gladys.fake.setValue(d, target('dhw-setpoint'), 45),
  ];
  await advance(5000, 50);
  for (const ack of acks) {
    assert.deepEqual(await ack, { success: true });
  }
  assert.deepEqual([pump.tags.I30, pump.tags.I32, pump.tags.A38], ['2', '2', '450']);
});

test('the password and the session never reach the logs, the statuses nor /data', async (t) => {
  const clock = testClock();
  const store = createMemoryStore();
  const pump = fakePump({ clock });
  const { logs, gladys, command, advance } = await setup(t, {
    pump,
    clock,
    store,
    config: ALLOWED,
  });
  pump.silent = /writeTags/;
  await command('heating-mode', 'manual');
  pump.expire();
  await advance(2 * MINUTE, SECOND);
  const seen = [
    logs.join('\n'),
    JSON.stringify(gladys.fake.connectionStatuses),
    JSON.stringify(store.data),
  ].join('\n');
  assert.doesNotMatch(seen, new RegExp(PASSWORD));
  assert.doesNotMatch(seen, /tok\d/);
});

test('EasyCon: read with Basic auth, every command refused (read only), Off included', async (t) => {
  const clock = testClock();
  const pump = fakePump({ clock });
  pump.handle = (path, headers) => {
    pump.requests.push({ path: new URL(path, 'http://p').pathname, auth: headers.authorization });
    return {
      status: 200,
      body: '<PCO><ANALOG><V><INDEX>1</INDEX><VALUE>3.5</VALUE></V></ANALOG><INTEGER><V><INDEX>30</INDEX><VALUE>1</VALUE></V></INTEGER></PCO>',
    };
  };
  const { gladys, command } = await setup(t, {
    pump,
    clock,
    config: { ...ALLOWED, system: 'easycon' },
  });
  assert.equal(pump.requests[0].path, '/config/xml.cgi');
  assert.equal(
    pump.requests[0].auth,
    `Basic ${Buffer.from(`waterkotte:${PASSWORD}`).toString('base64')}`,
  );
  assert.equal(last(gladys, 'temperature-outdoor'), 3.5);
  assert.match(message(gladys).fr, /EasyCon : lecture seule/);
  const mode = gladys.fake.devices[0].features.find(
    (f) => f.external_id === feature('heating-mode'),
  );
  assert.equal(mode.read_only, true);
  assert.match((await command('heating-mode', 'off')).error, /lecture seule/);
});
