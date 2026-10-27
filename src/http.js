// -----------------------------------------------------------------------------
// A small HTTP/1.1 GET client over node:net, for the web interface of the
// heat pump. Written here rather than node:http so that:
//   - `beforeSend` runs right before the first byte of the request leaves
//     (the last check of a command), and `sent` tells exactly whether the
//     request reached the socket;
//   - the answer is bounded (headers 8 KB, body 64 KB) and cut as soon as it
//     goes beyond, before it is read whole;
//   - the time of the last byte received is known: an arriving stop cuts a
//     read that stalls;
//   - one request per connection (`Connection: close`), never pipelined.
// Paths, cookies and authorization headers are never logged nor put in an
// error message: they carry the password or the session.
// -----------------------------------------------------------------------------

import { connect as netConnect } from 'node:net';
import { LIMITS, TIMINGS } from './constants.js';

export const ERROR_KINDS = {
  UNREACHABLE: 'unreachable',
  TIMEOUT: 'timeout',
  CLOSED: 'closed',
  PROTOCOL: 'protocol',
  TOO_LARGE: 'too-large',
  LATE: 'late',
  ABORTED: 'aborted',
};

export class HttpError extends Error {
  constructor(kind, { sent = false, code } = {}) {
    super(kind);
    this.kind = kind;
    this.sent = sent;
    this.code = code;
  }
}

/** A short reason for the status and the logs (never a path nor a header). */
export function errorReason(err) {
  if (err instanceof HttpError) {
    return err.code ? `${err.kind} (${err.code})` : err.kind;
  }
  return err?.reason ?? 'error';
}

/** Decodes a chunked body; undefined while incomplete; throws on a malformed one. */
function dechunk(buffer) {
  const parts = [];
  let at = 0;
  for (;;) {
    const eol = buffer.indexOf('\r\n', at);
    if (eol < 0) {
      return undefined;
    }
    const sizeText = buffer.subarray(at, eol).toString('latin1').split(';')[0].trim();
    if (!/^[0-9a-f]{1,6}$/i.test(sizeText)) {
      throw new HttpError(ERROR_KINDS.PROTOCOL, { sent: true });
    }
    const size = parseInt(sizeText, 16);
    if (size === 0) {
      return Buffer.concat(parts);
    }
    if (buffer.length < eol + 2 + size + 2) {
      return undefined;
    }
    parts.push(buffer.subarray(eol + 2, eol + 2 + size));
    at = eol + 2 + size + 2;
  }
}

/** Parses what was received; undefined while the answer is incomplete (and the socket open). */
export function parseResponse(buffer, ended) {
  const end = buffer.indexOf('\r\n\r\n');
  if (end < 0) {
    if (buffer.length > LIMITS.headerBytes) {
      throw new HttpError(ERROR_KINDS.TOO_LARGE, { sent: true });
    }
    if (ended) {
      throw new HttpError(ERROR_KINDS.PROTOCOL, { sent: true });
    }
    return undefined;
  }
  if (end > LIMITS.headerBytes) {
    throw new HttpError(ERROR_KINDS.TOO_LARGE, { sent: true });
  }
  const lines = buffer.subarray(0, end).toString('latin1').split('\r\n');
  const status = /^HTTP\/1\.[01] (\d{3})(?: |$)/.exec(lines[0]);
  if (!status) {
    throw new HttpError(ERROR_KINDS.PROTOCOL, { sent: true });
  }
  const headers = new Map();
  for (const line of lines.slice(1)) {
    const colon = line.indexOf(':');
    if (colon <= 0) {
      continue;
    }
    const name = line.slice(0, colon).trim().toLowerCase();
    const list = headers.get(name) ?? [];
    list.push(line.slice(colon + 1).trim());
    headers.set(name, list);
  }
  const rest = buffer.subarray(end + 4);
  let body;
  if ((headers.get('transfer-encoding')?.[0] ?? '').toLowerCase().includes('chunked')) {
    body = dechunk(rest);
  } else if (headers.has('content-length')) {
    const length = headers.get('content-length')[0];
    if (!/^\d{1,7}$/.test(length)) {
      throw new HttpError(ERROR_KINDS.PROTOCOL, { sent: true });
    }
    if (Number(length) > LIMITS.bodyBytes) {
      throw new HttpError(ERROR_KINDS.TOO_LARGE, { sent: true });
    }
    body = rest.length >= Number(length) ? rest.subarray(0, Number(length)) : undefined;
  } else if (ended) {
    body = rest;
  }
  if (body === undefined) {
    if (ended) {
      throw new HttpError(ERROR_KINDS.CLOSED, { sent: true });
    }
    return undefined;
  }
  return { status: Number(status[1]), headers, body: body.toString('utf8') };
}

/**
 * One GET. Options: `host`, `port`, `path` (already encoded), `headers`
 * (object), `monotonic`, `timers`, `startBy` (the request must leave by
 * then, else LATE, not sent), `answerBy` (the answer must be complete by
 * then, else TIMEOUT), `beforeSend` (sync; throwing stops the request, not
 * sent), `connect` (socket factory, tests). Returns `{ promise, abort,
 * lastActivity }`: `abort(kind)` ends it, `lastActivity()` is the monotonic
 * time of the last event (connection, byte received).
 */
export function httpGet({
  host,
  port,
  path,
  headers = {},
  monotonic,
  timers = globalThis,
  startBy,
  answerBy,
  beforeSend,
  connect = netConnect,
}) {
  let socket;
  let timer;
  let sent = false;
  let done = false;
  let last = monotonic();
  let finish;
  const chunks = [];
  let size = 0;

  const promise = new Promise((resolve, reject) => {
    finish = (err, value) => {
      if (done) {
        return;
      }
      done = true;
      if (timer) {
        timers.clearTimeout(timer);
      }
      socket?.destroy();
      if (err) {
        if (err instanceof HttpError) {
          err.sent = err.sent || sent;
        }
        reject(err);
      } else {
        resolve(value);
      }
    };
  });

  // Never an unhandled rejection when the caller attaches later (it always awaits it).
  promise.catch(() => {});
  const fail = (kind, code) => finish(new HttpError(kind, { sent, code }));
  const now = monotonic();
  const connectBy = Math.min(startBy ?? Infinity, now + TIMINGS.connectTimeout);
  if (connectBy <= now) {
    fail(ERROR_KINDS.LATE);
    return { promise, abort: () => {}, lastActivity: () => last };
  }
  // Until connected: the start deadline; then the answer deadline.
  timer = timers.setTimeout(
    () =>
      fail(
        startBy !== undefined && connectBy === startBy ? ERROR_KINDS.LATE : ERROR_KINDS.UNREACHABLE,
      ),
    connectBy - now,
  );

  const tryParse = (ended) => {
    let parsed;
    try {
      parsed = parseResponse(Buffer.concat(chunks), ended);
    } catch (err) {
      finish(err);
      return;
    }
    if (parsed) {
      finish(undefined, parsed);
    }
  };

  try {
    socket = connect({ host, port });
  } catch {
    fail(ERROR_KINDS.UNREACHABLE);
    return { promise, abort: () => {}, lastActivity: () => last };
  }
  socket.setNoDelay?.(true);
  socket.on('connect', () => {
    if (done) {
      return;
    }
    last = monotonic();
    timers.clearTimeout(timer);
    timer = undefined;
    if (startBy !== undefined && last > startBy) {
      fail(ERROR_KINDS.LATE);
      return;
    }
    try {
      beforeSend?.();
    } catch (err) {
      err.beforeSend = true;
      finish(err);
      return;
    }
    const lines = [`GET ${path} HTTP/1.1`, `Host: ${host}${port === 80 ? '' : `:${port}`}`];
    for (const [name, value] of Object.entries(headers)) {
      lines.push(`${name}: ${value}`);
    }
    lines.push('Accept: */*', 'Connection: close', '', '');
    sent = true;
    socket.write(lines.join('\r\n'));
    const left = (answerBy ?? last + TIMINGS.requestTimeout) - monotonic();
    timer = timers.setTimeout(() => fail(ERROR_KINDS.TIMEOUT), Math.max(0, left));
  });
  socket.on('data', (chunk) => {
    if (done) {
      return;
    }
    last = monotonic();
    if (!sent) {
      // A device that talks before being asked: not an answer to this request.
      fail(ERROR_KINDS.PROTOCOL);
      return;
    }
    size += chunk.length;
    if (size > LIMITS.headerBytes + LIMITS.bodyBytes) {
      fail(ERROR_KINDS.TOO_LARGE);
      return;
    }
    chunks.push(chunk);
    tryParse(false);
  });
  socket.on('end', () => {
    if (!done) {
      tryParse(true);
    }
  });
  socket.on('error', (err) => {
    if (!sent) {
      fail(ERROR_KINDS.UNREACHABLE, err.code);
    } else {
      fail(ERROR_KINDS.CLOSED, err.code);
    }
  });
  socket.on('close', () => {
    if (!done) {
      if (sent) {
        tryParse(true);
      } else {
        fail(ERROR_KINDS.UNREACHABLE);
      }
    }
  });
  return {
    promise,
    abort: (kind = ERROR_KINDS.ABORTED) => fail(kind),
    lastActivity: () => last,
  };
}
