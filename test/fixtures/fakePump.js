// -----------------------------------------------------------------------------
// A fake Waterkotte EcoTouch web interface, in memory: login with a session
// cookie, a limit of sessions, readTags / writeTags in the controller's text
// format, logout. `handle(path, headers)` answers one request; `connect` is a
// socket factory for the app (virtual time: latencies on the test clock);
// test/realclock.test.js serves the same `handle` over real HTTP.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

export const HOST = '192.168.1.50';
export const PASSWORD = 'pump-secret-42';

/** Raw tag values as the controller writes them (A in tenths). */
export const baseTags = () => ({
  I114: '1012',
  I115: '34567',
  A1: '52',
  A4: '81',
  A5: '45',
  A10: '305',
  A11: '298',
  A12: '341',
  A16: '330',
  A17: '-32768',
  A19: '487',
  A25: '18',
  A26: '72',
  A28: '40',
  A31: '350',
  A37: '480',
  A38: '500',
  I30: '1',
  I32: '1',
  I51: '264',
});

export function fakePump({ clock, password = PASSWORD, maxSessions = 2, tags = baseTags() } = {}) {
  const pump = {
    tags,
    password,
    maxSessions,
    sessions: new Set(),
    nextToken: 1,
    /** Every request: { path, query, cookie, auth, at }. */
    requests: [],
    connects: 0,
    /** Virtual ms before the answer; a function of the path for per-request latency. */
    latency: 0,
    /** Requests matching this RegExp get no answer at all (socket stays open). */
    silent: undefined,
    /** Requests matching this RegExp are handled on arrival, answered after the latency. */
    early: undefined,
    /** Connections are refused. */
    refuse: false,
    /** Writes are acknowledged, applied `applyDelay` ms later (Infinity: never). */
    applyDelay: 0,
    /** The next n answers are HTTP 503. */
    status5xx: 0,
    /** Every answer is padded with this many bytes. */
    bigBody: 0,
    /** The HTTP status of "#E_NEED_LOGIN" (some firmwares answer 500). */
    needLoginStatus: 200,
    /** Tags that answer E_INACTIVETAG. */
    inactive: new Set(),
    count: (re) => pump.requests.filter((r) => re.test(r.path)).length,
    writes: () => pump.requests.filter((r) => r.path.startsWith('/cgi/writeTags')),
    expire() {
      pump.sessions.clear();
    },
    handle(path, headers = {}) {
      const url = new URL(path, 'http://pump');
      const query = Object.fromEntries(url.searchParams);
      const cookie = /IDALToken=([^;]+)/.exec(headers.cookie ?? '')?.[1];
      pump.requests.push({
        path: url.pathname,
        query,
        cookie,
        auth: headers.authorization,
        raw: path,
      });
      if (pump.status5xx > 0) {
        pump.status5xx -= 1;
        return { status: 503, body: 'busy' };
      }
      const tagsOf = (names, values) =>
        names
          .map((t) =>
            pump.inactive.has(t)
              ? `#${t}\tE_INACTIVETAG\n`
              : values[t] === undefined
                ? `#${t}\tE_UNKNOWNTAG\n`
                : `#${t}\tS_OK\n192\t${values[t]}\n`,
          )
          .join('');
      const asked = () => {
        const n = Number(query.n);
        return Array.from({ length: n }, (_, i) => query[`t${i + 1}`]);
      };
      switch (url.pathname) {
        case '/cgi/login': {
          if (query.username !== 'waterkotte' || query.password !== pump.password) {
            return { status: 200, body: '#E_PASS_DONT_MATCH\n' };
          }
          if (pump.sessions.size >= pump.maxSessions) {
            return { status: 200, body: '#E_TOO_MANY_USERS\n' };
          }
          const token = `tok${pump.nextToken++}`;
          pump.sessions.add(token);
          return {
            status: 200,
            body: '#S_OK\nIDALToken=x\n',
            headers: { 'Set-Cookie': `IDALToken=${token}; path=/` },
          };
        }
        case '/cgi/logout':
          pump.sessions.delete(cookie);
          return { status: 200, body: '#S_OK\n' };
        case '/cgi/readTags':
          if (!pump.sessions.has(cookie)) {
            return { status: pump.needLoginStatus, body: '#E_NEED_LOGIN\n' };
          }
          return { status: 200, body: tagsOf(asked(), pump.tags) };
        case '/cgi/writeTags': {
          if (!pump.sessions.has(cookie)) {
            return { status: pump.needLoginStatus, body: '#E_NEED_LOGIN\n' };
          }
          const names = asked();
          const written = {};
          names.forEach((t, i) => {
            written[t] = query[`v${i + 1}`];
          });
          const apply = () => Object.assign(pump.tags, written);
          const delay =
            typeof pump.applyDelay === 'function' ? pump.applyDelay(written) : pump.applyDelay;
          if (delay === 0) {
            apply();
          } else if (Number.isFinite(delay)) {
            clock.timers.setTimeout(apply, delay);
          }
          return { status: 200, body: tagsOf(names, written) };
        }
        default:
          return { status: 404, body: 'not found' };
      }
    },
    /** The socket factory of the app (virtual time). */
    connect() {
      pump.connects += 1;
      const s = new EventEmitter();
      let destroyed = false;
      s.setNoDelay = () => s;
      s.destroy = () => {
        if (!destroyed) {
          destroyed = true;
          setImmediate(() => s.emit('close'));
        }
      };
      setImmediate(() => {
        if (destroyed) return;
        if (pump.refuse) {
          s.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          s.destroy();
          return;
        }
        s.emit('connect');
      });
      s.write = (text) => {
        const [line, ...rest] = String(text).split('\r\n');
        const path = line.split(' ')[1];
        const headers = {};
        for (const h of rest) {
          const c = h.indexOf(':');
          if (c > 0) headers[h.slice(0, c).toLowerCase()] = h.slice(c + 1).trim();
        }
        if (pump.silent?.test(path)) {
          pump.requests.push({
            path: new URL(path, 'http://pump').pathname,
            silent: true,
            raw: path,
          });
          return true;
        }
        const early = pump.early?.test(path) ? pump.handle(path, headers) : undefined;
        const answer = () => {
          if (destroyed) return;
          const { status, body, headers: h = {} } = early ?? pump.handle(path, headers);
          const payload = ' '.repeat(pump.bigBody) + body;
          const head = [`HTTP/1.1 ${status} X`, `Content-Length: ${Buffer.byteLength(payload)}`];
          for (const [k, v] of Object.entries(h)) head.push(`${k}: ${v}`);
          s.emit('data', Buffer.from(`${head.join('\r\n')}\r\n\r\n${payload}`));
          s.emit('end');
          s.destroy();
        };
        const latency = typeof pump.latency === 'function' ? pump.latency(path) : pump.latency;
        if (latency > 0) clock.timers.setTimeout(answer, latency);
        else setImmediate(answer);
        return true;
      };
      return s;
    },
  };
  return pump;
}
