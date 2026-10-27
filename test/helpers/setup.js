// -----------------------------------------------------------------------------
// End-to-end setup: the real SDK wiring (src/handlers.js) against the SDK's
// fake Gladys, the in-memory fake pump and the test clock of the kit (every
// read of the clock moves it; nothing fires until `advance`).
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { testClock } from '../kit/index.mjs';
import { WaterkotteApp } from '../../src/app.js';
import { registerHandlers } from '../../src/handlers.js';
import { createMemoryStore } from '../../src/store.js';
import { HOST, PASSWORD, fakePump } from '../fixtures/fakePump.js';

export { HOST, PASSWORD };
export const CONFIG = { address: HOST, password: PASSWORD };
export const ALLOWED = { ...CONFIG, allow_commands: true };
export const DEVICE = 'ext:test-integration:waterkotte:heatpump';
export const feature = (role) => `${DEVICE}:${role}`;

/** Lets the fake sockets and the promises run (setImmediate turns). */
export async function settle(rounds = 30) {
  for (let i = 0; i < rounds; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

export const recorder = (logs) =>
  Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((level) => [
      level,
      (...args) => logs.push(args.map((a) => (a instanceof Error ? a.stack : String(a))).join(' ')),
    ]),
  );

export async function setup(
  t,
  {
    config = CONFIG,
    pump,
    create = true,
    store = createMemoryStore(),
    clock = testClock(),
    devices,
    connectGladys = true,
  } = {},
) {
  pump ??= fakePump({ clock });
  const logs = [];
  const gladys = createFakeGladys({ config, ...(devices ? { devices } : {}) });
  const app = new WaterkotteApp({
    gladys,
    logger: recorder(logs),
    connect: pump.connect,
    now: clock.now,
    monotonic: clock.monotonic,
    timers: clock.timers,
    store,
    random: (n) => Buffer.alloc(n, 7),
  });
  registerHandlers(gladys, app);
  t.after(() => {
    app.halt();
    app.client?.close();
  });
  /** Moves the virtual clock by `ms`, in steps, letting the sockets answer. */
  const advance = async (ms, step = 100) => {
    for (let elapsed = 0; elapsed < ms; elapsed += step) {
      await clock.advance(Math.min(step, ms - elapsed));
      await settle();
    }
  };
  if (connectGladys) {
    await gladys.connect();
    await settle();
    await advance(100);
  }
  if (create && connectGladys) {
    for (const d of [...gladys.fake.discoveredDevices]) {
      await gladys.fake.deviceCreated(d);
    }
    await settle();
  }
  const device = () => gladys.fake.devices.find((x) => x.external_id === DEVICE);
  /** A command on a feature of the created device; resolves with the ack. */
  const command = async (role, value, { wait = 5000 } = {}) => {
    const d = device();
    const target = d.features.find((f) => f.external_id === feature(role));
    const ack = gladys.fake.setValue(d, target, value);
    await settle();
    await advance(wait);
    return ack;
  };
  return { gladys, app, pump, clock, store, logs, advance, command, device };
}

export const message = (gladys) => gladys.fake.connectionStatus?.message ?? {};
export const last = (gladys, role) => gladys.fake.lastState(feature(role));
