// -----------------------------------------------------------------------------
// The integration: the heat pump typed in the configuration (its address and
// the password of its web page), one read of its tags every poll interval,
// the Gladys device and its states, the transport badge, the "Test the
// connection" button, and the commands:
//
//   - "Off" of heating or of hot water is a STOP: it never depends on the
//     "Allow the commands" option, the bounds, a previous read, a pause, the
//     identity check, a command or a poll in progress. It jumps the queue,
//     makes a poll give the gate back and cuts a read silent for 1 s; it is
//     retried every 250 ms within its 3 s budget, read back, and when not
//     confirmed kept in /data and written again by the next reads (3 times at
//     most, 15 minutes at most, never over a value someone else set since).
//     Nothing clicked before it leaves after it.
//   - "Auto", "Manual" and the hot water setpoint are SENSITIVE: refused
//     unless the option allows them (checked on arrival and right before the
//     bytes leave), decided on a fresh read of the target and of the serial
//     number (never the values in memory), the setpoint bounded (28 °C to the
//     configured ceiling, 55 °C by default, never above 60 °C), /data saved
//     before the first byte, a success only when a read back shows the value.
//
// Two clocks: `now` (wall clock) dates what /data keeps; `monotonic` paces
// the reads, the pauses, the guards and the deadlines.
// -----------------------------------------------------------------------------

import { randomBytes } from 'node:crypto';
import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { ClientError, PRIORITY, REASONS, WaterkotteClient } from './client.js';
import { addressKey, connectionKey, fingerprint, normalizeConfig } from './config.js';
import {
  COMMANDS,
  DHW_CAP,
  DHW_SETPOINT,
  FEATURES as F,
  OPERATION,
  OPERATION_CODES,
  SECOND,
  SYSTEMS,
  TAGS,
  TIMINGS,
} from './constants.js';
import {
  COMMAND_ROLES,
  MODE_ROLES,
  buildDevice,
  decodeValues,
  deviceIds,
  deviceStates,
  parseFeatureId,
  reportedRoles,
  serialOf,
} from './devices.js';
import { ERROR_KINDS, errorReason } from './http.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { encodeEcotouch } from './protocol.js';
import { StatePublisher } from './publisher.js';
import { createFileStore } from './store.js';

const ALL_TAGS = Object.values(TAGS);
const MODE_TAGS = MODE_ROLES.map((role) => COMMANDS[role].tag);
const CONFIG_RETRY = 30 * SECOND;

/** A number sent by Gladys: a finite number, or a plain decimal text ('' and null are not 0). */
function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^-?\d{1,3}(\.\d{1,3})?$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/** A login allowed once per poll or command: never a loop of logins. */
const once = () => {
  let used = false;
  return () => {
    if (used) {
      return false;
    }
    used = true;
    return true;
  };
};

const isInt = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export class WaterkotteApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'waterkotte' }),
    connect,
    now = Date.now,
    monotonic = () => performance.now(),
    timers = globalThis,
    store = createFileStore(),
    random = (n) => randomBytes(n),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.monotonic = monotonic;
    this.timers = timers;
    this.store = store;
    this.random = random;
    this.publisher = new StatePublisher({ gladys, logger, monotonic, timers });
    this.config = normalizeConfig();
    this.client = undefined;
    this.generation = 0;
    this.started = false;
    this.timer = undefined;
    this.configTimer = undefined;
    this.followUps = new Set();
    this.running = undefined;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastTestAt = -Infinity;
    /** Roles seen during this run (a feature never disappears). */
    this.seen = new Set();
    /** The last read: values (identity checked), online, failures, error, wait. */
    this.values = undefined;
    this.serial = undefined;
    this.identity = undefined;
    this.online = undefined;
    this.failures = 0;
    this.wait = undefined;
    this.error = undefined;
    this.lastReadAt = undefined;
    /** Commands: arrival numbers, the last stop number per target, the targets busy. */
    this.seq = 0;
    this.stopSeqs = new Map();
    this.busy = new Set();
    /** role -> { from, expected, moved, until }: a sensitive command sent, not seen yet. */
    this.guards = new Map();
    this.loadState();
  }

  // --- /data -----------------------------------------------------------------------

  /** Reads /data once: stops, refusal, pause, last attempt; dates in the future are invalid. */
  loadState() {
    const { data, readable } = this.store.load();
    this.storeReadable = readable;
    const wall = this.now();
    const mono = this.monotonic();
    /** role -> { from, at, deadline, sends, seq } (seq 0: from /data, older than any click). */
    this.stops = new Map();
    for (const s of Array.isArray(data.stops) ? data.stops : []) {
      if (
        MODE_ROLES.includes(s?.role) &&
        Number.isFinite(s.at) &&
        Number.isFinite(s.deadline) &&
        s.at <= wall &&
        s.deadline > wall &&
        s.deadline - s.at <= TIMINGS.stopKeep &&
        isInt(s.sends, 0, TIMINGS.stopResends) &&
        (s.from === undefined || s.from === null || isInt(s.from, 1, 255))
      ) {
        this.stops.set(s.role, {
          from: s.from ?? undefined,
          at: s.at,
          deadline: s.deadline,
          sends: s.sends,
          seq: 0,
        });
      }
    }
    const r = data.refusal;
    this.refusal =
      r && typeof r.salt === 'string' && /^[0-9a-f]{32}$/.test(r.salt) && isInt(r.fp, 0, 255)
        ? { salt: r.salt, fp: r.fp }
        : undefined;
    const p = data.pause;
    this.pause = undefined;
    if (p && Number.isFinite(p.until) && isInt(p.length, TIMINGS.pauseMin, TIMINGS.pauseMax)) {
      const left = Math.min(p.until - wall, TIMINGS.pauseMax);
      if (left > 0) {
        this.pause = {
          due: mono + left,
          length: p.length,
          kind: p.kind === REASONS.SERVER_ERROR ? REASONS.SERVER_ERROR : REASONS.TOO_MANY_USERS,
        };
      }
    }
    // The last attempt brought onto the monotonic clock; a date in the future is invalid.
    this.lastReadAt =
      Number.isFinite(data.lastAttemptAt) && data.lastAttemptAt <= wall
        ? mono - Math.min(wall - data.lastAttemptAt, TIMINGS.pauseMax)
        : undefined;
  }

  snapshot() {
    const wall = this.now();
    const mono = this.monotonic();
    return {
      version: 1,
      stops: [...this.stops].map(([role, s]) => ({
        role,
        ...(s.from === undefined ? {} : { from: s.from }),
        at: s.at,
        deadline: s.deadline,
        sends: s.sends,
      })),
      ...(this.refusal ? { refusal: this.refusal } : {}),
      ...(this.pause && this.pause.due > mono
        ? {
            pause: {
              until: wall + Math.min(this.pause.due - mono, TIMINGS.pauseMax),
              length: this.pause.length,
              kind: this.pause.kind,
            },
          }
        : {}),
      ...(this.lastReadAt === undefined
        ? {}
        : { lastAttemptAt: wall - Math.max(0, mono - this.lastReadAt) }),
    };
  }

  /** Saves /data; false when it failed or when /data is unreadable (never overwritten then). */
  async persist() {
    if (!this.storeReadable) {
      return false;
    }
    try {
      await this.store.save(this.snapshot());
      return true;
    } catch (err) {
      this.logger.warn(`Saving /data failed: ${err.message}`);
      return false;
    }
  }

  // --- Lifecycle -------------------------------------------------------------------

  /**
   * Connected to Gladys: read the configuration (retried every 30 s without
   * end when it fails), start the first time, else resend what Gladys keeps
   * in memory only (status, Discovery list, badges, states).
   */
  async connected(getConfig) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`Reading the configuration failed: ${err.message}`);
      await this.setStatus(false, T.configUnavailable(age(CONFIG_RETRY)));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connected(getConfig).catch(() => {});
      }, CONFIG_RETRY);
      return;
    }
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (connectionKey(normalizeConfig(raw)) !== connectionKey(this.config)) {
      await this.start(raw);
      return;
    }
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    await this.publishAll();
  }

  async start(raw = {}) {
    const previous = this.client;
    this.halt();
    if (previous) {
      await previous.logout();
      previous.close();
    }
    this.config = normalizeConfig(raw);
    this.values = undefined;
    this.serial = undefined;
    this.identity = undefined;
    this.online = undefined;
    this.failures = 0;
    this.error = undefined;
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    if (this.refusal && this.config.credentials) {
      const { username, password } = this.config.credentials;
      if (fingerprint(this.refusal.salt, username, password) !== this.refusal.fp) {
        // New credentials: the refusal is lifted.
        this.refusal = undefined;
        await this.persist();
      }
    }
    this.client =
      this.config.address && !this.config.credentialsError
        ? new WaterkotteClient({
            address: this.config.address,
            system: this.config.system,
            credentials: this.config.credentials,
            monotonic: this.monotonic,
            now: this.now,
            timers: this.timers,
            ...(this.connect ? { connect: this.connect } : {}),
          })
        : undefined;
    this.publisher.start();
    if (!this.client) {
      await this.publishAll();
      return;
    }
    await this.setStatus(false, T.connecting);
    // A stop kept in /data goes first, before the first poll.
    if (this.stops.size > 0 && !this.refusal) {
      await this.stopRound();
    }
    this.schedule();
  }

  /** Stops the timers and invalidates what runs (generation). */
  halt() {
    this.generation += 1;
    this.clearTimer();
    for (const handle of this.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.followUps.clear();
    this.publisher.stop();
  }

  /** Shutdown: the session is ended (one of the few the controller accepts), /data written. */
  async close() {
    const client = this.client;
    this.halt();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    if (client) {
      await client.logout();
      client.close();
    }
    await this.persist();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
    }
  }

  /** A new address, system, credentials or interval restarts; the rest applies at once. */
  async configUpdated(raw = {}) {
    const next = normalizeConfig(raw);
    if (connectionKey(next) !== connectionKey(this.config)) {
      await this.start(raw);
      return;
    }
    const previous = this.config;
    this.config = next;
    if (next.allowCommands !== previous.allowCommands) {
      this.logger.info(`Commands ${next.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (next.language !== previous.language) {
      this.published = undefined;
      await this.publishAll();
    }
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- Polling ---------------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The rest of the pause (ms), capped at every use; 0 when none. */
  pauseLeft(mono) {
    if (!this.pause) {
      return 0;
    }
    return Math.min(Math.max(0, this.pause.due - mono), TIMINGS.pauseMax);
  }

  /** When the next read may start, on the caller's instant `mono` (one read of the clock per decision). */
  dueAt(mono) {
    const spacing = this.online === false ? (this.wait ?? this.interval) : this.interval;
    const due = this.lastReadAt === undefined ? mono : this.lastReadAt + spacing;
    return Math.max(due, mono + this.pauseLeft(mono));
  }

  schedule() {
    this.clearTimer();
    if (!this.client || this.refusal) {
      return;
    }
    const mono = this.monotonic();
    let wait = this.dueAt(mono) - mono;
    if (this.pauseLeft(mono) > 0 && this.stops.size > 0) {
      // Stops do not wait for the end of a pause.
      wait = Math.min(wait, this.interval);
    }
    const generation = this.generation;
    this.timer = this.timers.setTimeout(
      () => {
        this.timer = undefined;
        if (generation === this.generation) {
          this.tick().catch((err) => this.logger.error(`Refresh failed: ${err.message}`));
        }
      },
      Math.max(0, wait),
    );
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    if (!this.running) {
      this.running = this.run().finally(() => {
        this.running = undefined;
      });
    }
    return this.running;
  }

  async run() {
    const client = this.client;
    const generation = this.generation;
    if (!client || this.refusal) {
      await this.publishAll();
      return;
    }
    const mono = this.monotonic();
    if (this.pauseLeft(mono) > 0) {
      if (this.stops.size > 0) {
        await this.stopRound();
      }
      if (generation === this.generation) {
        await this.publishAll();
        this.schedule();
      }
      return;
    }
    if (mono < this.dueAt(mono)) {
      // A follow-up or a button while paced: never sooner than the interval.
      this.schedule();
      return;
    }
    await this.poll(mono, client, generation);
  }

  /** One read of the heat pump, decided by run() at `mono` (the spied decision of the real-clock test). */
  async poll(mono, client, generation) {
    this.lastReadAt = mono;
    // The time of the attempt is kept before the read: a restart never reads sooner.
    await this.persist();
    let read;
    try {
      read = await client.hold(PRIORITY.POLL, async (hold) => {
        const allowLogin = once();
        const result = await client.read(hold, ALL_TAGS, { allowLogin });
        if (this.stops.size > 0) {
          await this.resendStops(hold, result, allowLogin);
        }
        return result;
      });
    } catch (err) {
      if (generation !== this.generation) {
        return;
      }
      await this.failed(err);
      await this.publishAll();
      if (generation === this.generation) {
        this.schedule();
      }
      return;
    }
    if (generation !== this.generation) {
      return;
    }
    this.succeeded(read);
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule();
    }
  }

  succeeded(read) {
    const values = decodeValues(TAGS, read);
    this.online = true;
    this.failures = 0;
    this.wait = undefined;
    this.error = undefined;
    if (this.pause) {
      this.pause = undefined;
      this.persist().catch(() => {});
    }
    const pinned = serialOf(this.createdDevice());
    if (pinned && values.serial !== pinned) {
      // Checked at every read: an unreadable serial is not another heat pump, but nothing is published.
      this.identity =
        values.serial === undefined
          ? { kind: 'unreadable' }
          : { kind: 'other', serial: values.serial };
      this.values = undefined;
      return;
    }
    this.identity = undefined;
    this.serial = values.serial;
    this.values = values;
    for (const role of reportedRoles(values)) {
      this.seen.add(role);
    }
    this.observe(values);
  }

  async failed(err) {
    const reason = err.reason ?? errorReason(err);
    if (reason === REASONS.PREEMPTED) {
      // Cut by a stop: not a failure.
      return;
    }
    this.online = false;
    this.values = undefined;
    if (reason === REASONS.BAD_PASSWORD) {
      await this.setRefusal();
      return;
    }
    if (reason === REASONS.TOO_MANY_USERS || reason === REASONS.SERVER_ERROR) {
      await this.setPause(reason);
      return;
    }
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(this.failures, TIMINGS.backoff.length - 1)],
    );
    this.failures += 1;
    this.wait = wait;
    this.error = reason;
    this.logger.warn(
      `Heat pump ${addressKey(this.config.address)}: ${reason}; next try in ${Math.round(wait / 1000)} s`,
    );
  }

  async setRefusal() {
    const { username, password } = this.config.credentials ?? {};
    if (username === undefined) {
      return;
    }
    const salt = this.random(16).toString('hex');
    this.refusal = { salt, fp: fingerprint(salt, username, password) };
    this.logger.warn('Heat pump: credentials refused; no automatic retry');
    await this.persist();
  }

  async setPause(kind) {
    const mono = this.monotonic();
    const length = Math.min(
      TIMINGS.pauseMax,
      Math.max(TIMINGS.pauseMin, (this.pause?.length ?? TIMINGS.pauseMin / 2) * 2),
    );
    this.pause = { due: mono + length, length, kind };
    this.error = kind;
    this.logger.warn(`Heat pump: ${kind}; pause of ${Math.round(length / 1000)} s`);
    await this.persist();
  }

  // --- Stops (protective) ------------------------------------------------------------

  /**
   * Writes the stops kept, from a read of the operation tags `read`: a stop
   * the read shows done is forgotten; one contradicted (the value changed
   * to another than before the stop: someone set it since) is dropped; the
   * others are written together, each checked against its deadline and its
   * count (a send counts only when it left).
   */
  async resendStops(hold, read, allowLogin) {
    const wall = this.now();
    const entries = [];
    let changed = false;
    for (const [role, stop] of [...this.stops]) {
      const { tag } = COMMANDS[role];
      const entry = read.get(tag);
      const code = entry?.status === 'ok' ? entry.value : undefined;
      if (stop.at > wall || wall >= stop.deadline) {
        this.logger.warn(`Stop ${role} not confirmed within its time: dropped`);
        this.stops.delete(role);
        changed = true;
      } else if (code === OPERATION_CODES.off) {
        this.stops.delete(role);
        changed = true;
      } else if (code !== undefined && stop.from !== undefined && code !== stop.from) {
        this.logger.warn(`Stop ${role}: changed to ${code} since, not written again`);
        this.stops.delete(role);
        changed = true;
      } else if (stop.sends >= TIMINGS.stopResends) {
        this.logger.warn(`Stop ${role} still not applied after ${stop.sends} writes: dropped`);
        this.stops.delete(role);
        changed = true;
      } else {
        // An unknown value: in doubt, the stop goes.
        entries.push([role, tag]);
      }
    }
    if (entries.length > 0) {
      try {
        await this.client.write(
          hold,
          entries.map(([, tag]) => [tag, encodeEcotouch(tag, OPERATION_CODES.off)]),
          { allowLogin, keep: true },
        );
        this.countSends(entries);
      } catch (err) {
        if (err.sent) {
          this.countSends(entries);
        }
        this.logger.warn(`Writing the stops again failed: ${err.reason ?? errorReason(err)}`);
      }
      changed = true;
    }
    if (changed) {
      await this.persist();
    }
  }

  countSends(entries) {
    for (const [role] of entries) {
      const stop = this.stops.get(role);
      if (stop) {
        stop.sends += 1;
      }
    }
  }

  /** The stops kept, alone: a read of the operation tags then their writes (start, pause). */
  async stopRound() {
    const client = this.client;
    if (!client || this.refusal || this.config.system !== SYSTEMS.ECOTOUCH) {
      return;
    }
    try {
      await client.hold(PRIORITY.STOP, async (hold) => {
        const allowLogin = once();
        const read = await client.read(hold, MODE_TAGS, { allowLogin, keep: true });
        await this.resendStops(hold, read, allowLogin);
      });
    } catch (err) {
      if (err.reason === REASONS.BAD_PASSWORD) {
        await this.setRefusal();
      }
      this.logger.warn(`Stop round failed: ${err.reason ?? errorReason(err)}`);
    }
  }

  /** "Off" of heating or hot water. */
  async stopCommand(role, received) {
    const seq = (this.seq += 1);
    this.stopSeqs.set(role, seq);
    this.guards.delete(role);
    const { tag, key } = COMMANDS[role];
    const wall = this.now();
    const before = this.values?.[key];
    const stop = {
      // The value before the stop: a later read showing another one means someone set it since.
      from: isInt(before, 1, 255) ? before : undefined,
      at: wall,
      deadline: wall + TIMINGS.stopKeep,
      sends: 0,
      seq,
    };
    this.stops.set(role, stop);
    const client = this.client;
    if (!client) {
      await this.persist();
      throw this.refusalError(ERRORS.stop.noConfig);
    }
    if (this.refusal) {
      // The refused credentials are never sent again by a stop.
      await this.persist();
      throw this.refusalError(ERRORS.stop.refused);
    }
    const sendBy = received + TIMINGS.commandSendBy;
    let outcome;
    try {
      outcome = await client.hold(
        PRIORITY.STOP,
        (hold) => this.stopSession(hold, client, tag, received, sendBy),
        { startBy: sendBy },
      );
    } catch (err) {
      outcome = { error: err };
    }
    const current = this.stops.get(role) === stop;
    if (outcome.error) {
      const err = outcome.error;
      const reason = err.reason ?? errorReason(err);
      if (reason === REASONS.BAD_PASSWORD) {
        await this.setRefusal();
      } else {
        await this.persist();
      }
      this.logger.warn(`Stop ${role}: ${reason} (${err.sent ? 'sent' : 'not sent'})`);
      if (err.sent) {
        this.followUp();
        throw this.refusalError(ERRORS.stop.unconfirmed(reason));
      }
      throw this.refusalError(
        reason === REASONS.BAD_PASSWORD ? ERRORS.stop.refused : ERRORS.stop.notSent(reason),
      );
    }
    if (outcome.confirmed) {
      if (current) {
        this.stops.delete(role);
      }
      if (this.values) {
        this.values[key] = OPERATION_CODES.off;
        this.publishAll().catch(() => {});
      }
      await this.persist();
      this.logger.info(`Stop ${role}: confirmed`);
      return;
    }
    await this.persist();
    this.followUp();
    throw this.refusalError(
      outcome.readError ? ERRORS.stop.unconfirmed(outcome.readError) : ERRORS.stop.notYetApplied,
    );
  }

  /** The write of a stop (retried every 250 ms until it leaves, within its budget), then its read back. */
  async stopSession(hold, client, tag, received, sendBy) {
    const allowLogin = once();
    for (;;) {
      try {
        await client.write(hold, [[tag, encodeEcotouch(tag, OPERATION_CODES.off)]], {
          startBy: sendBy,
          answerBy: received + TIMINGS.commandAnswerBy,
          allowLogin,
          keep: true,
        });
        break;
      } catch (err) {
        if (
          err.sent ||
          err.reason === REASONS.BAD_PASSWORD ||
          this.monotonic() + TIMINGS.stopRetry >= sendBy
        ) {
          throw err;
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.stopRetry));
      }
    }
    try {
      const read = await client.read(hold, [tag], {
        answerBy: received + TIMINGS.commandConfirmBy,
        allowLogin: () => false,
        keep: true,
      });
      const entry = read.get(tag);
      return { confirmed: entry?.status === 'ok' && entry.value === OPERATION_CODES.off };
    } catch (err) {
      return { readError: err.reason ?? errorReason(err) };
    }
  }

  // --- Sensitive commands -----------------------------------------------------------

  refusalError(text) {
    return new Error(word(text, this.config.language));
  }

  /** The value of a sensitive command, checked strictly: `{ code | degrees, expected, wire }`. */
  parseCommand(role, value) {
    const { tag } = COMMANDS[role];
    if (MODE_ROLES.includes(role)) {
      if (typeof value !== 'string' || !Object.hasOwn(OPERATION_CODES, value)) {
        throw this.refusalError(ERRORS.badMode);
      }
      const code = OPERATION_CODES[value];
      return { expected: code, wire: encodeEcotouch(tag, code), label: value };
    }
    const number = numberOf(value);
    if (number === undefined) {
      throw this.refusalError(ERRORS.badNumber);
    }
    // Whole degrees (water-heater commands are integers), within the bounds.
    if (!Number.isInteger(number)) {
      throw this.refusalError(ERRORS.badStep);
    }
    if (number < DHW_SETPOINT.min || number > DHW_CAP.max) {
      throw this.refusalError(ERRORS.outOfRange(DHW_SETPOINT.min, DHW_CAP.max));
    }
    if (number > this.config.dhwCap) {
      throw this.refusalError(ERRORS.dhwCap(this.config.dhwCap));
    }
    return {
      expected: number * 10,
      wire: encodeEcotouch(tag, number),
      label: `${number} °C`,
      degrees: number,
    };
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.monotonic();
    const role = parseFeatureId(this.gladys, feature?.external_id);
    if (!role || !COMMAND_ROLES.includes(role)) {
      throw this.refusalError(ERRORS.readOnly);
    }
    if (this.config.system !== SYSTEMS.ECOTOUCH) {
      throw this.refusalError(ERRORS.easyconReadOnly);
    }
    if (MODE_ROLES.includes(role) && value === 'off') {
      return this.stopCommand(role, received);
    }
    const wanted = this.parseCommand(role, value);
    if (!this.config.allowCommands) {
      throw this.refusalError(ERRORS.disabled);
    }
    if (!this.client) {
      throw this.refusalError(ERRORS.noConfig);
    }
    if (this.refusal) {
      throw this.refusalError(ERRORS.credentialsRefused);
    }
    const left = this.pauseLeft(received);
    if (left > 0) {
      throw this.refusalError(ERRORS.paused(age(left)));
    }
    if (!this.storeReadable) {
      throw this.refusalError(ERRORS.storeUnreadable);
    }
    if (role === F.DHW_SETPOINT && this.stops.has(F.DHW_MODE)) {
      throw this.refusalError(ERRORS.stopPending);
    }
    if (this.busy.has(role)) {
      throw this.refusalError(ERRORS.stillRunning);
    }
    const seq = (this.seq += 1);
    this.busy.add(role);
    try {
      return await this.command(role, wanted, seq, received);
    } finally {
      this.busy.delete(role);
    }
  }

  /** The checks before sending, on the latest configuration and the latest stops. */
  checkCommand(generation, client, role, seq, wanted) {
    if (!this.config.allowCommands) {
      throw this.refusalError(ERRORS.disabled);
    }
    if (generation !== this.generation || client !== this.client) {
      throw this.refusalError(ERRORS.noConfig);
    }
    if ((this.stopSeqs.get(role) ?? 0) > seq) {
      throw this.refusalError(ERRORS.cancelledByStop);
    }
    if (role === F.DHW_SETPOINT) {
      if ((this.stopSeqs.get(F.DHW_MODE) ?? 0) > seq) {
        throw this.refusalError(ERRORS.cancelledByStop);
      }
      if (this.stops.has(F.DHW_MODE)) {
        throw this.refusalError(ERRORS.stopPending);
      }
      // The ceiling may have been lowered since the command arrived.
      if (wanted.degrees > this.config.dhwCap || wanted.degrees > DHW_CAP.max) {
        throw this.refusalError(ERRORS.dhwCap(this.config.dhwCap));
      }
    }
  }

  /** What a command compares: the operation code, or the setpoint in tenths. */
  comparable(role, entry) {
    if (entry?.status !== 'ok') {
      return undefined;
    }
    return role === F.DHW_SETPOINT ? Math.round(entry.value * 10) : entry.value;
  }

  async command(role, wanted, seq, received) {
    const generation = this.generation;
    const client = this.client;
    const sendBy = received + TIMINGS.commandSendBy;
    const readBy = sendBy - TIMINGS.commandMinSend;
    if (this.monotonic() >= readBy) {
      throw this.refusalError(ERRORS.tooSlow);
    }
    this.checkCommand(generation, client, role, seq, wanted);
    try {
      return await client.hold(
        PRIORITY.COMMAND,
        (hold) =>
          this.commandSession(hold, {
            client,
            generation,
            role,
            wanted,
            seq,
            received,
            sendBy,
            readBy,
          }),
        { startBy: readBy },
      );
    } catch (err) {
      if (err instanceof ClientError || err.kind) {
        const reason = err.reason ?? errorReason(err);
        if (err.kind === ERROR_KINDS.LATE || err.kind === ERROR_KINDS.TIMEOUT) {
          throw this.refusalError(ERRORS.tooSlow);
        }
        if (reason === REASONS.BAD_PASSWORD) {
          await this.setRefusal();
          throw this.refusalError(ERRORS.credentialsRefused);
        }
        throw this.refusalError(ERRORS.notSent(reason));
      }
      throw err;
    }
  }

  async commandSession(hold, { client, generation, role, wanted, seq, received, sendBy, readBy }) {
    const { tag } = COMMANDS[role];
    const allowLogin = once();
    // The target and the serial just before acting, never the values in memory.
    const read = await client.read(hold, [tag, TAGS.serialHigh, TAGS.serialLow], {
      startBy: readBy,
      answerBy: readBy,
      allowLogin,
      keep: true,
    });
    this.checkCommand(generation, client, role, seq, wanted);
    const pinned = serialOf(this.createdDevice());
    if (pinned) {
      const serial = decodeValues(TAGS, read).serial;
      if (serial === undefined) {
        throw this.refusalError(ERRORS.identityUnreadable);
      }
      if (serial !== pinned) {
        throw this.refusalError(ERRORS.otherDevice);
      }
    }
    const current = this.comparable(role, read.get(tag));
    if (current === undefined) {
      throw this.refusalError(ERRORS.missingValue);
    }
    if (MODE_ROLES.includes(role) && !Object.hasOwn(OPERATION, current)) {
      throw this.refusalError(ERRORS.unknownMode(current));
    }
    const stop = this.stops.get(role);
    const stopOlder = stop && stop.seq < seq;
    if (current === wanted.expected && !this.guardActive(role) && !stopOlder) {
      // Already so: nothing sent.
      return;
    }
    // Before the first byte: /data saved, without the stop this newer command replaces.
    if (stopOlder) {
      this.stops.delete(role);
    }
    const restore = async () => {
      if (stopOlder && !this.stops.has(role) && (this.stopSeqs.get(role) ?? 0) === stop.seq) {
        this.stops.set(role, stop);
        await this.persist();
      }
    };
    if (!(await this.persist())) {
      await restore();
      throw this.refusalError(this.storeReadable ? ERRORS.saveFailed : ERRORS.storeUnreadable);
    }
    if (this.monotonic() > sendBy) {
      await restore();
      throw this.refusalError(ERRORS.tooSlow);
    }
    this.logger.info(`Command ${role}: ${wanted.label}`);
    const plan = { from: current, expected: wanted.expected };
    try {
      await client.write(hold, [[tag, wanted.wire]], {
        startBy: sendBy,
        answerBy: received + TIMINGS.commandAnswerBy,
        // The very last check, right before the bytes leave.
        beforeSend: () => this.checkCommand(generation, client, role, seq, wanted),
        allowLogin,
      });
    } catch (err) {
      if (err.beforeSend) {
        await restore();
        throw err;
      }
      const reason = err.reason ?? errorReason(err);
      if (!err.sent) {
        await restore();
        if (reason === REASONS.BAD_PASSWORD) {
          await this.setRefusal();
          throw this.refusalError(ERRORS.credentialsRefused);
        }
        throw this.refusalError(
          err.kind === ERROR_KINDS.LATE ? ERRORS.tooSlow : ERRORS.notSent(reason),
        );
      }
      this.logger.warn(`Command ${role}: ${wanted.label} sent, ${reason}`);
      this.guard(role, plan);
      this.followUp();
      throw this.refusalError(ERRORS.sentUnconfirmed(reason));
    }
    // The read back decides.
    let back;
    try {
      const again = await client.read(hold, [tag], {
        answerBy: received + TIMINGS.commandConfirmBy,
        allowLogin: () => false,
        keep: true,
      });
      back = this.comparable(role, again.get(tag));
    } catch (err) {
      this.guard(role, plan);
      this.followUp();
      throw this.refusalError(ERRORS.sentUnconfirmed(err.reason ?? errorReason(err)));
    }
    if (back === wanted.expected) {
      this.guards.delete(role);
      if (this.values) {
        this.values[COMMANDS[role].key] = role === F.DHW_SETPOINT ? back / 10 : back;
        this.publishAll().catch(() => {});
      }
      return;
    }
    this.guard(role, plan);
    this.followUp();
    throw this.refusalError(
      back === current ? ERRORS.notYetApplied : ERRORS.sentUnconfirmed('protocol'),
    );
  }

  /** Reads after a command, spaced: its effect, then a check (the pause still applies). */
  followUp() {
    const generation = this.generation;
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        this.followUps.delete(handle);
        if (generation === this.generation) {
          // A follow-up read is due now, whatever the interval.
          this.lastReadAt = undefined;
          this.tick().catch(() => {});
        }
      }, delay);
      this.followUps.add(handle);
    }
  }

  // --- Guards -------------------------------------------------------------------------

  guard(role, plan) {
    this.guards.set(role, { ...plan, moved: false, until: this.monotonic() + TIMINGS.guard });
  }

  guardActive(role) {
    const guard = this.guards.get(role);
    if (guard && this.monotonic() >= guard.until) {
      this.guards.delete(role);
      return false;
    }
    return Boolean(guard);
  }

  /** A read through the guards: never lifted on an unknown value nor on the start value. */
  observe(values) {
    for (const role of COMMAND_ROLES) {
      if (!this.guardActive(role)) {
        continue;
      }
      const raw = values[COMMANDS[role].key];
      if (raw === undefined) {
        continue;
      }
      const value = role === F.DHW_SETPOINT ? Math.round(raw * 10) : raw;
      const guard = this.guards.get(role);
      if (value !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && value === guard.expected) {
        this.guards.delete(role);
      }
    }
  }

  // --- Gladys --------------------------------------------------------------------------

  createdDevice() {
    const id = deviceIds(this.gladys).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === id);
  }

  get live() {
    return Boolean(this.client && this.online === true && this.values);
  }

  async publishAll() {
    await this.publishDevices();
    this.queueStates();
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
    await this.publishBadge();
    await this.updateStatus();
  }

  async publishDevices() {
    if (this.seen.size === 0 || this.identity) {
      return;
    }
    const device = buildDevice(this.gladys, {
      roles: this.seen,
      system: this.config.system,
      serial: this.serial,
      language: this.config.language,
      created: this.createdDevice(),
    });
    const json = JSON.stringify([device]);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices([device]);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  queueStates(created = this.createdFeatures()) {
    if (!this.live || !this.createdDevice()) {
      return;
    }
    for (const { device_feature_external_id: id, ...value } of deviceStates(
      deviceIds(this.gladys),
      this.values,
    )) {
      if (created.has(id)) {
        this.publisher.push(id, value);
      }
    }
  }

  createdFeatures() {
    return new Set((this.createdDevice()?.features ?? []).map((f) => f.external_id));
  }

  async publishBadge() {
    const device = this.createdDevice();
    if (!device || (this.online === undefined && this.client)) {
      return;
    }
    const entries = [
      {
        external_id: device.external_id,
        transport: this.live ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      },
    ];
    const json = JSON.stringify(entries);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  async updateStatus() {
    const [connected, message] = this.status();
    await this.setStatus(connected, message);
  }

  status() {
    const c = this.config;
    if (!c.address) {
      return [false, c.invalid ? join([T.noAddress, T.invalid(c.invalid)]) : T.noAddress];
    }
    if (c.credentialsError) {
      return [false, T.credentials[c.credentialsError]];
    }
    if (this.refusal) {
      return [false, T.refused];
    }
    const mono = this.monotonic();
    const left = this.pauseLeft(mono);
    if (left > 0) {
      return [
        false,
        this.pause.kind === REASONS.SERVER_ERROR
          ? T.serverError(age(left))
          : T.tooManyUsers(age(left)),
      ];
    }
    if (this.online === false) {
      return [
        false,
        T.unreachable(addressKey(c.address), this.error, age(this.wait ?? this.interval)),
      ];
    }
    if (this.online === undefined) {
      return [false, T.connecting];
    }
    const notes = [];
    if (this.identity?.kind === 'other') {
      notes.push(T.notes.otherDevice(this.identity.serial));
    } else if (this.identity?.kind === 'unreadable') {
      notes.push(T.notes.identityUnreadable);
    }
    if (this.stops.size > 0) {
      notes.push(T.notes.stopsPending);
    }
    if (!this.storeReadable) {
      notes.push(T.notes.storeUnreadable);
    }
    if (c.system === SYSTEMS.EASYCON) {
      notes.push(T.notes.easycon);
    }
    const model = c.system === SYSTEMS.EASYCON ? 'EasyCon' : 'EcoTouch';
    return [true, T.connected(model, this.serial, notes)];
  }

  /** A device was created (or updated): its last values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f.external_id);
    }
    this.queueStates(created);
    await this.publisher.flush().catch(() => {});
    await this.publishBadge();
    await this.updateStatus();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device of the last read, sent again (no new read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button -------------------------------------------------------------

  lastMessage() {
    return JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? T.connecting;
  }

  async testConnection() {
    const c = this.config;
    if (!c.address || c.credentialsError || !this.client) {
      return this.status()[1];
    }
    const mono = this.monotonic();
    if (mono - this.lastTestAt < TIMINGS.testCooldown) {
      return join([T.test.cooldown, this.lastMessage()]);
    }
    this.lastTestAt = mono;
    if (this.refusal) {
      // One login per click: a success lifts the refusal.
      const client = this.client;
      try {
        await client.hold(PRIORITY.POLL, (hold) => client.login(hold));
        this.refusal = undefined;
        await this.persist();
        this.logger.info('Heat pump: credentials accepted, polling again');
        this.lastReadAt = undefined;
        await this.tick();
      } catch (err) {
        const reason = err.reason ?? errorReason(err);
        if (reason !== REASONS.BAD_PASSWORD) {
          return join([
            T.refused,
            T.unreachable(addressKey(c.address), reason, age(this.interval)),
          ]);
        }
      }
      await this.updateStatus();
      return this.lastMessage();
    }
    if (this.pauseLeft(mono) > 0 || mono < this.dueAt(mono)) {
      // Never sooner than the interval nor during a pause: the last status.
      await this.updateStatus();
      const wait = Math.max(this.dueAt(mono) - mono, 0);
      return this.pauseLeft(mono) > 0
        ? this.lastMessage()
        : join([this.lastMessage(), T.test.notYet(age(wait))]);
    }
    await this.tick();
    return this.lastMessage();
  }
}
