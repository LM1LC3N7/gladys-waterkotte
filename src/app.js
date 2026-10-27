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
//     most, 15 minutes at most; once written, not again over a value someone
//     else set since). Nothing clicked before it leaves after it.
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

/**
 * A login allowed once per poll, command or stop: never a loop of logins. A
 * login that did not leave (no connection) gives its turn back (`refund`).
 */
const once = () => {
  let used = false;
  const allow = () => {
    if (used) {
      return false;
    }
    used = true;
    return true;
  };
  allow.refund = () => {
    used = false;
  };
  return allow;
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
    this.closed = false;
    /**
     * The configurations, applied one at a time (`applying`): `wanted` is the
     * latest received and not applied yet, `received` counts them, `resend`
     * asks to send again what Gladys keeps in memory only (reconnection).
     */
    this.wanted = undefined;
    this.received = 0;
    this.resend = false;
    this.applying = undefined;
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
    /** role -> { seq, code }: the last mode Gladys wrote (a stop is not "contradicted" by an older one). */
    this.lastWrites = new Map();
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
    /**
     * role -> { seq, atMono, deadlineMono, written, sends, from }: seq 0
     * comes from /data (older than any click); `from` is the value of a read
     * that started after the stop arrived; `sends` the writes again that left.
     */
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
          seq: 0,
          atMono: mono - (wall - s.at),
          deadlineMono: mono + (s.deadline - wall),
          written: s.written === true,
          sends: s.sends,
          from: s.from ?? undefined,
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
      // Wall clock only here: the monotonic dates of the stops brought onto it.
      stops: [...this.stops].map(([role, s]) => ({
        role,
        ...(s.from === undefined ? {} : { from: s.from }),
        at: wall - Math.max(0, mono - s.atMono),
        deadline: wall + Math.max(0, s.deadlineMono - mono),
        written: s.written,
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
   * end when it fails) and apply it like a save, then resend what Gladys
   * keeps in memory only (status, Discovery list, badges, states). A save
   * received while getConfig() ran is at least as new as its answer: the
   * answer is not applied then.
   */
  async connected(getConfig) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    if (this.closed) {
      return;
    }
    const asked = this.received;
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      if (this.closed) {
        return;
      }
      this.logger.warn(`Reading the configuration failed: ${err.message}`);
      await this.setStatus(false, T.configUnavailable(age(CONFIG_RETRY)));
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.connected(getConfig).catch(() => {});
      }, CONFIG_RETRY);
      return;
    }
    await this.receive(this.received === asked ? (raw ?? {}) : undefined, { resend: true });
  }

  /**
   * The configuration saved, applied after those received before it: a new
   * address, system, credentials or interval restarts, the rest applies at once.
   */
  configUpdated(raw = {}) {
    return this.receive(raw);
  }

  /**
   * A configuration received (`raw`; undefined: only `resend`). The
   * configurations are applied one at a time, the latest received winning:
   * never two restarts at once, never an older one over a newer one. Until
   * it is applied, a newer configuration already restricts the sensitive
   * commands (`allowCommands`, `dhwCap`). Resolves once every configuration
   * received so far is applied.
   */
  receive(raw, { resend = false } = {}) {
    if (this.closed) {
      return Promise.resolve();
    }
    if (raw !== undefined) {
      this.received += 1;
      this.wanted = normalizeConfig(raw);
    }
    this.resend ||= resend;
    if (!this.applying) {
      // Started after `applying` is set: the loop clears it when it ends.
      this.applying = Promise.resolve().then(() => this.applyAll());
    }
    return this.applying;
  }

  async applyAll() {
    try {
      while (!this.closed && (this.wanted || this.resend)) {
        const next = this.wanted;
        if (next && (!this.started || connectionKey(next) !== connectionKey(this.config))) {
          await this.restart();
          continue;
        }
        // Same connection: applied at once, without a restart.
        const resend = this.resend;
        this.resend = false;
        let republish = resend;
        if (next) {
          this.wanted = undefined;
          const previous = this.config;
          this.config = next;
          if (next.allowCommands !== previous.allowCommands) {
            this.logger.info(`Commands ${next.allowCommands ? 'allowed' : 'disabled'}`);
          }
          republish ||= next.language !== previous.language;
        }
        if (resend) {
          this.badge = undefined;
          this.lastStatus = undefined;
          this.gladys.forgetPublishedStates?.();
        }
        if (republish) {
          this.published = undefined;
          await this.publishAll();
        }
      }
    } finally {
      // In the same turn as the last check: a configuration received later starts a new loop.
      this.applying = undefined;
    }
  }

  /**
   * The option and the ceiling of the sensitive commands: those applied,
   * never looser than a configuration received and not applied yet.
   */
  get allowCommands() {
    return this.config.allowCommands && (this.wanted?.allowCommands ?? true);
  }

  get dhwCap() {
    return Math.min(this.config.dhwCap, this.wanted?.dhwCap ?? DHW_CAP.max);
  }

  /**
   * Restarts on the latest configuration received, read once the previous
   * client logged out (one saved meanwhile wins). While it logs out, no
   * client is current: an Off arriving then waits for the new one (its first
   * stop round writes it), never sent on the old one. Shut down meanwhile:
   * no new client.
   */
  async restart() {
    const previous = this.client;
    this.client = undefined;
    this.closing = previous;
    this.halt();
    const generation = this.generation;
    if (previous) {
      await previous.logout();
      previous.close();
    }
    this.closing = undefined;
    if (generation !== this.generation) {
      return;
    }
    this.started = true;
    this.config = this.wanted ?? this.config;
    this.wanted = undefined;
    // A restart sends everything again: no resend needed after it.
    this.resend = false;
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
        if (generation !== this.generation) {
          return;
        }
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
    if (generation !== this.generation) {
      return;
    }
    // A stop kept in /data goes first, before the first poll.
    if (this.stops.size > 0 && !this.refusal) {
      await this.stopRound();
      if (generation !== this.generation) {
        return;
      }
      if (this.stopsNeedRound(this.monotonic())) {
        this.scheduleStops(TIMINGS.stopRound);
      }
    }
    this.schedule();
  }

  /** Stops the timers and invalidates what runs (generation). */
  halt() {
    this.generation += 1;
    this.clearTimer();
    if (this.stopTimer) {
      this.timers.clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    for (const handle of this.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.followUps.clear();
    this.publisher.stop();
  }

  /**
   * Shutdown: the session is ended (one of the few the controller accepts),
   * /data written. No configuration is applied any more; a restart in
   * progress ends after the logout of the previous client, without a new one
   * (or its new client is logged out here).
   */
  async close() {
    this.closed = true;
    this.wanted = undefined;
    this.resend = false;
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
    await this.applying;
    await this.persist();
  }

  clearTimer() {
    if (this.timer) {
      this.timers.clearTimeout(this.timer);
      this.timer = undefined;
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
    for (const stop of this.stops.values()) {
      // Woken at the deadline of a stop: it is dropped then, whatever the reads.
      wait = Math.min(wait, stop.deadlineMono - mono);
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
    if (this.purgeStops(mono)) {
      await this.persist();
    }
    if (this.pauseLeft(mono) > 0) {
      // The stops have their own rounds during a pause (scheduleStops).
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
        // Stops arrived after this number are not judged on this read.
        const readSeq = this.seq;
        const result = await client.read(hold, ALL_TAGS, { allowLogin });
        if (this.stops.size > 0 && !hold.preempted) {
          await this.resendStops(client, hold, result, allowLogin, readSeq);
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
    if (this.stops.size > 0 && !this.stopTimer) {
      this.scheduleStops(TIMINGS.stopRound);
    }
  }

  // --- Stops (protective) ------------------------------------------------------------

  /** Drops the stops past their deadline (monotonic), whatever the reads; true when one went. */
  purgeStops(mono) {
    let changed = false;
    for (const [role, stop] of [...this.stops]) {
      if (mono >= stop.deadlineMono) {
        this.logger.warn(`Stop ${role} not confirmed within its time: dropped`);
        this.stops.delete(role);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * The rounds of the stops between the polls: 10 s after an Off that could
   * not be written, then every minute while one is not written yet or while
   * a pause holds the polls, until their deadline (15 logins at most per
   * stop, as a poll every minute). Stops never wait for the end of a pause.
   */
  scheduleStops(delay = TIMINGS.stopRound) {
    if (this.stopTimer) {
      this.timers.clearTimeout(this.stopTimer);
      this.stopTimer = undefined;
    }
    if (
      !this.client ||
      this.refusal ||
      this.stops.size === 0 ||
      this.config.system !== SYSTEMS.ECOTOUCH
    ) {
      return;
    }
    const generation = this.generation;
    this.stopTimer = this.timers.setTimeout(
      () => {
        this.stopTimer = undefined;
        if (generation === this.generation) {
          this.stopRoundDue().catch((err) => this.logger.warn(`Stop round failed: ${err.message}`));
        }
      },
      Math.max(0, delay),
    );
  }

  /** Whether the stops need their own round: one not written yet, or a pause. */
  stopsNeedRound(mono) {
    return (
      this.stops.size > 0 &&
      (this.pauseLeft(mono) > 0 || [...this.stops.values()].some((stop) => !stop.written))
    );
  }

  async stopRoundDue() {
    const generation = this.generation;
    if (this.purgeStops(this.monotonic())) {
      await this.persist();
    }
    if (this.stopsNeedRound(this.monotonic())) {
      await this.stopRound();
    }
    if (generation === this.generation && this.stopsNeedRound(this.monotonic())) {
      this.scheduleStops(TIMINGS.stopRound);
    }
  }

  /**
   * Writes the stops kept, from a read of the operation tags `read` that
   * started when the arrival number was `readSeq` (a stop arrived later is
   * not judged on it). A stop the read shows done is forgotten. The first
   * read after a stop gives its `from`. A stop already written whose value
   * then changed to another one, not by an older command of Gladys, was
   * set by someone else: dropped. A stop never written is never dropped by a
   * read. The others are written together, on the `client` of the read; a
   * write again counts only when it left, 3 at most.
   */
  async resendStops(client, hold, read, allowLogin, readSeq, justWritten = new Set()) {
    const mono = this.monotonic();
    const entries = [];
    let changed = this.purgeStops(mono);
    for (const [role, stop] of [...this.stops]) {
      if (stop.seq > readSeq) {
        continue;
      }
      const { tag } = COMMANDS[role];
      const entry = read.get(tag);
      const code = entry?.status === 'ok' ? entry.value : undefined;
      if (code === OPERATION_CODES.off) {
        // Read back Off: done (an Off waiting for a restart answers a success).
        stop.done = true;
        this.stops.delete(role);
        changed = true;
        continue;
      }
      if (code !== undefined && stop.from === undefined) {
        stop.from = code;
        changed = true;
      } else if (code !== undefined && code !== stop.from) {
        const mine = this.lastWrites.get(role);
        // An older command of Gladys, sent within the guard time (90 s), explains the change.
        const ours =
          mine && mine.seq < stop.seq && mine.code === code && mono - mine.at < TIMINGS.guard;
        if (stop.written && !ours) {
          this.logger.warn(`Stop ${role}: set to ${code} by someone else since, not written again`);
          this.stops.delete(role);
          changed = true;
          continue;
        }
        stop.from = code;
        changed = true;
      }
      if (stop.written && stop.sends >= TIMINGS.stopResends) {
        this.logger.warn(
          `Stop ${role} still not applied after ${stop.sends} writes again: dropped`,
        );
        this.stops.delete(role);
        changed = true;
        continue;
      }
      if (justWritten.has(role)) {
        // Written by this round just before the read: judged by the next one.
        continue;
      }
      // An unknown value: in doubt, the stop goes.
      entries.push([role, tag]);
    }
    if (entries.length > 0) {
      try {
        await client.write(
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
        if (stop.written) {
          stop.sends += 1;
        }
        stop.written = true;
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
        // The stops never written go first, without waiting for a read (in
        // doubt, a stop goes); then a read judges the others and gives theirs.
        const fresh = [...this.stops].filter(([, stop]) => !stop.written).map(([role]) => role);
        const justWritten = new Set();
        if (fresh.length > 0) {
          try {
            await client.write(
              hold,
              fresh.map((role) => [
                COMMANDS[role].tag,
                encodeEcotouch(COMMANDS[role].tag, OPERATION_CODES.off),
              ]),
              { allowLogin, keep: true },
            );
            fresh.forEach((role) => justWritten.add(role));
          } catch (err) {
            if (err.sent) {
              fresh.forEach((role) => justWritten.add(role));
            }
            if (!err.sent && err.inLogin) {
              throw err;
            }
          } finally {
            for (const role of justWritten) {
              const stop = this.stops.get(role);
              if (stop) {
                stop.written = true;
              }
            }
            if (justWritten.size > 0) {
              await this.persist();
            }
          }
        }
        const readSeq = this.seq;
        const read = await client.read(hold, MODE_TAGS, { allowLogin, keep: true });
        await this.resendStops(client, hold, read, allowLogin, readSeq, justWritten);
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
    const stop = {
      seq,
      atMono: received,
      deadlineMono: received + TIMINGS.stopKeep,
      written: false,
      sends: 0,
      // Only a read that left after this click tells the value to compare with.
      from: undefined,
    };
    this.stops.set(role, stop);
    if (!this.client && this.applying) {
      // A new configuration is being applied: the first stop round of its
      // client writes this stop and reads it back. The old client gives its
      // gate back at once: a poll in flight yields, a frozen read is cut.
      this.closing?.hold(PRIORITY.STOP, async () => {}).catch(() => {});
      await this.persist();
      const startBy = received + TIMINGS.commandSendBy - TIMINGS.commandMinSend;
      // Configurations saved in a row: until the last one has its client, within the budget.
      while (!this.client && this.applying && this.monotonic() < startBy) {
        await this.waitFor(this.applying, startBy);
      }
      if (stop.written) {
        // Written by that round: its read back gets the time of a read back.
        const confirmBy = received + TIMINGS.commandConfirmBy;
        while (!stop.done && this.applying && this.monotonic() < confirmBy) {
          await this.waitFor(this.applying, confirmBy);
        }
        if (stop.done) {
          return;
        }
        if (this.client) {
          this.followUp();
        }
        this.scheduleStops(TIMINGS.stopRound);
        // Read back another value: not applied yet; no read back: no answer in time.
        throw this.refusalError(
          stop.from === undefined ? ERRORS.stop.unconfirmed('timeout') : ERRORS.stop.notYetApplied,
        );
      }
      if (this.client ? this.monotonic() >= startBy : this.applying) {
        // Still starting at the end of the budget: written by the first round of the new client.
        this.scheduleStops(TIMINGS.stopQuick);
        throw this.refusalError(ERRORS.stop.notSent('timeout'));
      }
      if (this.config.system !== SYSTEMS.ECOTOUCH) {
        // The new controller is EasyCon (read only here): refused like any Off there, not kept.
        if (this.stops.get(role) === stop) {
          this.stops.delete(role);
          await this.persist();
        }
        throw this.refusalError(ERRORS.easyconReadOnly);
      }
      // Started in time: sent below on the new client, or refused (no configuration, credentials refused).
    }
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
        (hold) => this.stopSession(hold, client, tag, received, sendBy, stop),
        { startBy: sendBy },
      );
    } catch (err) {
      outcome = { error: err };
    }
    const current = this.stops.get(role) === stop;
    if (outcome.error) {
      const err = outcome.error;
      // The gate not free in time (the controller slow on a request before): "no answer in time".
      const reason = err.kind === ERROR_KINDS.LATE ? 'timeout' : (err.reason ?? errorReason(err));
      if (err.sent && !err.inLogin) {
        stop.written = true;
      }
      if (reason === REASONS.BAD_PASSWORD) {
        await this.setRefusal();
      } else {
        await this.persist();
      }
      this.logger.warn(`Stop ${role}: ${reason} (${stop.written ? 'sent' : 'not sent'})`);
      if (stop.written) {
        this.followUp();
        this.scheduleStops(TIMINGS.stopRound);
        throw this.refusalError(ERRORS.stop.unconfirmed(reason));
      }
      // Not written: a round in 10 s, not the next poll.
      this.scheduleStops(TIMINGS.stopQuick);
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
    this.scheduleStops(TIMINGS.stopRound);
    throw this.refusalError(
      outcome.readError ? ERRORS.stop.unconfirmed(outcome.readError) : ERRORS.stop.notYetApplied,
    );
  }

  /** The write of a stop (retried every 250 ms until it leaves, within its budget), then its read back. */
  async stopSession(hold, client, tag, received, sendBy, stop) {
    const allowLogin = once();
    for (;;) {
      try {
        await client.write(hold, [[tag, encodeEcotouch(tag, OPERATION_CODES.off)]], {
          startBy: sendBy,
          answerBy: received + TIMINGS.commandAnswerBy,
          allowLogin,
          keep: true,
        });
        stop.written = true;
        break;
      } catch (err) {
        // Retried only when nothing reached the controller (no connection,
        // login included: its turn is given back); anything else ends here.
        if (
          err.kind !== ERROR_KINDS.UNREACHABLE ||
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
      const confirmed = entry?.status === 'ok' && entry.value === OPERATION_CODES.off;
      if (!confirmed && entry?.status === 'ok') {
        // Read after the click: the value a later read compares with.
        stop.from = entry.value;
      }
      return { confirmed };
    } catch (err) {
      return { readError: err.reason ?? errorReason(err) };
    }
  }

  // --- Sensitive commands -----------------------------------------------------------

  /** Waits for `promise`, or until the monotonic time `until` (whichever first). */
  waitFor(promise, until) {
    return new Promise((resolve) => {
      const handle = this.timers.setTimeout(resolve, Math.max(0, until - this.monotonic()));
      promise.then(
        () => {
          this.timers.clearTimeout(handle);
          resolve();
        },
        () => {
          this.timers.clearTimeout(handle);
          resolve();
        },
      );
    });
  }

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
    if (number > this.dhwCap) {
      throw this.refusalError(ERRORS.dhwCap(this.dhwCap));
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
    if (!this.allowCommands) {
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
    if (!this.allowCommands) {
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
      if (wanted.degrees > this.dhwCap || wanted.degrees > DHW_CAP.max) {
        throw this.refusalError(ERRORS.dhwCap(this.dhwCap));
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
        beforeSend: () => {
          this.checkCommand(generation, client, role, seq, wanted);
          if (MODE_ROLES.includes(role)) {
            // An older command of Gladys: a stop arriving later is not "contradicted" by it.
            this.lastWrites.set(role, { seq, code: wanted.expected, at: this.monotonic() });
          }
        },
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
      return [false, c.invalid ? join([T.noAddress, T.invalid]) : T.noAddress];
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
