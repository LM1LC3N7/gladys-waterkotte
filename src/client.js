// -----------------------------------------------------------------------------
// The client of ONE heat pump: its session and its gate.
//
// The gate: one request at a time to the controller (an embedded web server
// that accepts few sessions and is slow), held by a poll or a command for
// all its requests (a command: fresh read, write, read back, nothing in
// between). Waiting holders are served stops first, then commands, then
// polls, each in arrival order. A stop that arrives:
//   - asks a poll that holds the gate to give it back before its next request;
//   - cuts the request in flight when it has been silent for 1 s or more and
//     is not a write (a frozen read never delays a stop); the poll does not
//     count it as a failure.
//
// The session (EcoTouch): one login, its cookie kept for every request. A
// session that expired ("#E_NEED_LOGIN") logs in again only when the caller
// allows it (the app: once per poll, once per command), never in a loop.
// "#E_PASS_DONT_MATCH" is a refusal of the credentials; "#E_TOO_MANY_USERS"
// a pause. The cookie and the password are never logged.
// -----------------------------------------------------------------------------

import { DEFAULT_PORT, LIMITS, SYSTEMS, TIMINGS } from './constants.js';
import { ERROR_KINDS, HttpError, httpGet } from './http.js';
import {
  GLOBAL,
  easyconPath,
  globalStatus,
  loginPath,
  logoutPath,
  parseEasycon,
  parseTags,
  readPath,
  writePath,
} from './protocol.js';

export const PRIORITY = { POLL: 1, COMMAND: 2, STOP: 3 };

/** Why a request failed beyond HTTP: the reasons the app tells apart. */
export const REASONS = {
  BAD_PASSWORD: 'badPassword',
  TOO_MANY_USERS: 'tooManyUsers',
  NEED_LOGIN: 'needLogin',
  SERVER_ERROR: 'serverError',
  HTTP_STATUS: 'httpStatus',
  PROTOCOL: 'protocol',
  PREEMPTED: 'preempted',
  UNSUPPORTED: 'unsupported',
};

export class ClientError extends Error {
  constructor(reason, { sent = false, status } = {}) {
    super(reason);
    this.reason = reason;
    this.sent = sent;
    this.status = status;
  }
}

/** The cookies of a login answer: `name=value` pairs, bounded; never logged. */
export function cookiesOf(headers) {
  const pairs = [];
  for (const line of headers.get('set-cookie') ?? []) {
    const pair = line.split(';', 1)[0].trim();
    const match = /^([A-Za-z0-9_.-]{1,64})=([\x21-\x2b\x2d-\x3a\x3c-\x7e]{0,512})$/.exec(pair);
    if (match && pair.length <= LIMITS.cookieBytes) {
      pairs.push(pair);
    }
  }
  return pairs.length > 0 ? pairs.slice(0, 4).join('; ') : undefined;
}

export class WaterkotteClient {
  constructor({ address, system, credentials, monotonic, timers = globalThis, connect, now }) {
    this.host = address.host;
    this.port = address.port ?? DEFAULT_PORT;
    this.system = system;
    this.credentials = credentials;
    this.monotonic = monotonic;
    this.now = now;
    this.timers = timers;
    this.connect = connect;
    /** The session cookie (EcoTouch); undefined: no session. */
    this.cookie = undefined;
    this.queue = [];
    this.current = undefined;
    this.watchdog = undefined;
    this.closed = false;
    this.seq = 0;
  }

  // --- The gate ------------------------------------------------------------------

  /**
   * Runs `fn(hold)` alone on the controller. `startBy` (monotonic): still
   * waiting then, it is refused LATE, nothing sent. `hold.preempted` is set
   * when a stop waits; `hold.get(...)` refuses to start a request then
   * (polls), unless `{ keep: true }` (commands finish their own).
   */
  hold(priority, fn, { startBy } = {}) {
    if (this.closed) {
      return Promise.reject(new HttpError(ERROR_KINDS.ABORTED));
    }
    return new Promise((resolve, reject) => {
      const entry = { priority, fn, startBy, resolve, reject, seq: (this.seq += 1) };
      this.queue.push(entry);
      this.queue.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
      if (entry.startBy !== undefined) {
        entry.timer = this.timers.setTimeout(
          () => {
            const at = this.queue.indexOf(entry);
            if (at >= 0) {
              this.queue.splice(at, 1);
              reject(new HttpError(ERROR_KINDS.LATE));
            }
          },
          Math.max(0, entry.startBy - this.monotonic()),
        );
      }
      if (priority === PRIORITY.STOP) {
        this.stopWaiting();
      }
      this.next();
    });
  }

  next() {
    if (this.current || this.queue.length === 0) {
      this.updateWatchdog();
      return;
    }
    const entry = this.queue.shift();
    if (entry.timer) {
      this.timers.clearTimeout(entry.timer);
    }
    const hold = {
      priority: entry.priority,
      preempted: false,
      request: undefined,
      get: (path, options) => this.request(hold, path, options),
    };
    this.current = hold;
    if (this.queue.some((e) => e.priority === PRIORITY.STOP) && entry.priority < PRIORITY.STOP) {
      hold.preempted = true;
    }
    this.updateWatchdog();
    Promise.resolve()
      .then(() => entry.fn(hold))
      .then(entry.resolve, entry.reject)
      .finally(() => {
        if (this.current === hold) {
          this.current = undefined;
        }
        this.next();
      });
  }

  /** A stop waits: the poll holding the gate gives it back, a frozen read is cut. */
  stopWaiting() {
    const hold = this.current;
    if (hold && hold.priority < PRIORITY.STOP) {
      if (hold.priority === PRIORITY.POLL) {
        hold.preempted = true;
      }
      this.cutStalled();
    }
  }

  cutStalled() {
    const hold = this.current;
    const request = hold?.request;
    if (
      hold &&
      hold.priority < PRIORITY.STOP &&
      request &&
      !request.write &&
      this.monotonic() - request.lastActivity() >= TIMINGS.stalled
    ) {
      request.abort(ERROR_KINDS.ABORTED);
      request.preempted = true;
    }
  }

  updateWatchdog() {
    const waiting = this.queue.some((e) => e.priority === PRIORITY.STOP);
    if (waiting && this.current && !this.watchdog) {
      this.watchdog = this.timers.setInterval(() => this.cutStalled(), 100);
    } else if ((!waiting || !this.current) && this.watchdog) {
      this.timers.clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }

  /** One HTTP request inside a hold. */
  async request(hold, path, { startBy, answerBy, beforeSend, write = false, auth, keep } = {}) {
    // A closed client sends nothing more, not even a login.
    if (this.closed || this.current !== hold) {
      throw new HttpError(ERROR_KINDS.ABORTED);
    }
    if (hold.preempted && !keep) {
      throw new ClientError(REASONS.PREEMPTED);
    }
    const headers = {};
    if (auth === 'cookie' && this.cookie) {
      headers.Cookie = this.cookie;
    }
    if (auth === 'basic' && this.credentials) {
      const { username, password } = this.credentials;
      headers.Authorization = `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
    }
    const request = httpGet({
      host: this.host,
      port: this.port,
      path,
      headers,
      monotonic: this.monotonic,
      timers: this.timers,
      startBy,
      answerBy,
      beforeSend,
      ...(this.connect ? { connect: this.connect } : {}),
    });
    request.write = write;
    hold.request = request;
    if (hold.priority < PRIORITY.STOP && this.queue.some((e) => e.priority === PRIORITY.STOP)) {
      this.cutStalled();
    }
    try {
      return await request.promise;
    } catch (err) {
      if (request.preempted && err instanceof HttpError) {
        throw new ClientError(REASONS.PREEMPTED, { sent: err.sent });
      }
      throw err;
    } finally {
      if (hold.request === request) {
        hold.request = undefined;
      }
    }
  }

  // --- The session (EcoTouch) -----------------------------------------------------

  checkStatus(response) {
    if (response.status >= 500) {
      throw new ClientError(REASONS.SERVER_ERROR, { sent: true, status: response.status });
    }
    if (response.status !== 200) {
      throw new ClientError(REASONS.HTTP_STATUS, { sent: true, status: response.status });
    }
  }

  async login(hold, options = {}) {
    if (!this.credentials) {
      throw new ClientError(REASONS.BAD_PASSWORD);
    }
    this.cookie = undefined;
    const { username, password } = this.credentials;
    const response = await hold.get(loginPath(username, password), options);
    // The status of the body first, whatever the HTTP code (some firmwares answer 500).
    const status = globalStatus(response.body);
    if (status === GLOBAL.OK && response.status === 200) {
      // Some firmwares answer without a cookie: the session then rides on the address.
      this.cookie = cookiesOf(response.headers) ?? '';
      return;
    }
    if (status === GLOBAL.BAD_PASSWORD) {
      throw new ClientError(REASONS.BAD_PASSWORD, { sent: true });
    }
    if (status === GLOBAL.TOO_MANY_USERS) {
      throw new ClientError(REASONS.TOO_MANY_USERS, { sent: true });
    }
    this.checkStatus(response);
    throw new ClientError(REASONS.PROTOCOL, { sent: true });
  }

  /**
   * One EcoTouch request with the session: logs in first when there is
   * none and `allowLogin()` says so; on "#E_NEED_LOGIN" (in a 200 or a 5xx,
   * as ha-waterkotte reads it), logs in once more and asks again when
   * `allowLogin()` still says so. A login that did not leave gives its turn
   * back (`allowLogin.refund`). An error of the login is never "sent": only
   * the request itself counts. Returns the body.
   */
  async withSession(hold, path, options, allowLogin) {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.cookie === undefined) {
        if (!allowLogin()) {
          throw new ClientError(REASONS.NEED_LOGIN);
        }
        try {
          await this.login(hold, { ...options, beforeSend: undefined, write: false });
        } catch (err) {
          if (!err.sent) {
            allowLogin.refund?.();
          }
          err.sent = false;
          err.inLogin = true;
          throw err;
        }
      }
      const response = await hold.get(path, { ...options, auth: 'cookie' });
      const status = globalStatus(response.body);
      if (status === GLOBAL.NEED_LOGIN) {
        // Nothing was read nor written: the session is gone.
        this.cookie = undefined;
        continue;
      }
      if (response.status >= 500) {
        // The next attempt logs in again (once): a session may be what failed.
        this.cookie = undefined;
      }
      this.checkStatus(response);
      if (status === GLOBAL.TOO_MANY_USERS) {
        throw new ClientError(REASONS.TOO_MANY_USERS, { sent: true });
      }
      if (status === GLOBAL.BAD_PASSWORD) {
        throw new ClientError(REASONS.BAD_PASSWORD, { sent: true });
      }
      return response.body;
    }
    throw new ClientError(REASONS.NEED_LOGIN, { sent: false });
  }

  /** Reads tags: Map tag -> { status, value }. */
  async read(hold, tags, { allowLogin = () => true, ...options } = {}) {
    if (this.system === SYSTEMS.EASYCON) {
      const response = await hold.get(easyconPath(tags), { ...options, auth: 'basic' });
      if (response.status === 401) {
        throw new ClientError(REASONS.BAD_PASSWORD, { sent: true, status: 401 });
      }
      this.checkStatus(response);
      return parseEasycon(response.body, tags);
    }
    const body = await this.withSession(hold, readPath(tags, this.now()), options, allowLogin);
    return parseTags(body, tags);
  }

  /**
   * Writes `entries` ([[tag, wire value]]) in one request (EcoTouch only).
   * A session that expired is not a write: logged in again and sent again
   * within the deadlines. Returns Map tag -> { status, value } of the answer.
   */
  async write(hold, entries, { allowLogin = () => true, ...options } = {}) {
    if (this.system !== SYSTEMS.ECOTOUCH) {
      throw new ClientError(REASONS.UNSUPPORTED);
    }
    const body = await this.withSession(
      hold,
      writePath(entries, this.now()),
      { ...options, write: true, keep: true },
      allowLogin,
    );
    return parseTags(
      body,
      entries.map(([tag]) => tag),
    );
  }

  /**
   * Ends the session (best effort), so that it does not hold one of the two
   * the controller accepts: after the request in flight (5 s at most), 1 s
   * for the answer.
   */
  async logout() {
    if (this.system !== SYSTEMS.ECOTOUCH || !this.cookie || this.closed) {
      return;
    }
    const startBy = this.monotonic() + TIMINGS.requestTimeout;
    try {
      await this.hold(
        PRIORITY.COMMAND,
        (hold) =>
          hold.get(logoutPath(), {
            startBy,
            answerBy: startBy + TIMINGS.stalled,
            auth: 'cookie',
            keep: true,
          }),
        { startBy },
      );
    } catch {
      // Best effort: the controller ends idle sessions itself.
    }
    this.cookie = undefined;
  }

  /** Stops everything: the request in flight is cut, the waiting holders refused. */
  close() {
    this.closed = true;
    for (const entry of this.queue.splice(0)) {
      if (entry.timer) {
        this.timers.clearTimeout(entry.timer);
      }
      entry.reject(new HttpError(ERROR_KINDS.ABORTED));
    }
    this.current?.request?.abort(ERROR_KINDS.ABORTED);
    if (this.watchdog) {
      this.timers.clearInterval(this.watchdog);
      this.watchdog = undefined;
    }
  }
}
