// -----------------------------------------------------------------------------
// The two web interfaces (pure parsing) and the HTTP client bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { testClock } from './kit/index.mjs';
import { LIMITS } from '../src/constants.js';
import { ERROR_KINDS, httpGet, parseResponse } from '../src/http.js';
import {
  decodeEcotouch,
  easyconPath,
  encodeEcotouch,
  globalStatus,
  parseEasycon,
  parseTags,
  readPath,
  writePath,
} from '../src/protocol.js';
import { cookiesOf } from '../src/client.js';

test('readTags and writeTags paths', () => {
  assert.equal(readPath(['A1', 'I30'], 1234.9), '/cgi/readTags?n=2&t1=A1&t2=I30&_=1234');
  assert.equal(
    writePath([['I30', '0']], 5),
    '/cgi/writeTags?n=1&returnValue=true&rnd=5&t1=I30&v1=0',
  );
  assert.equal(easyconPath(['A1', 'A38', 'I30', 'I115']), '/config/xml.cgi?A|1|38|I|30|115');
});

test('values: analog in tenths, integers strict, no fraction for an integer', () => {
  assert.equal(decodeEcotouch('A1', '52'), 5.2);
  assert.equal(decodeEcotouch('A1', '-35'), -3.5);
  assert.equal(decodeEcotouch('I30', '2'), 2);
  assert.equal(decodeEcotouch('I30', '2.0'), 2);
  assert.equal(decodeEcotouch('I30', '2.5'), undefined);
  for (const bad of ['', ' ', 'abc', '1e3', '0x10', '12345678', null, undefined]) {
    assert.equal(decodeEcotouch('A1', bad), undefined, String(bad));
  }
  assert.equal(encodeEcotouch('A38', 55), '550');
  assert.equal(encodeEcotouch('I30', 0), '0');
});

test('a readTags answer: statuses, inactive, missing, only the asked tags', () => {
  const body =
    '#A1\tS_OK\n192\t52\r\n#I30\tE_INACTIVETAG\n#A38\tS_OK\n192\t\n#X9\tS_OK\n1\t1\n#A2\tS_OK\n192\t7\n';
  const tags = parseTags(body, ['A1', 'I30', 'A38', 'A19']);
  assert.deepEqual(tags.get('A1'), { status: 'ok', value: 5.2 });
  assert.deepEqual(tags.get('I30'), { status: 'inactive' });
  assert.deepEqual(tags.get('A38'), { status: 'error' });
  assert.deepEqual(tags.get('A19'), { status: 'missing' });
  assert.equal(tags.has('A2'), false);
  assert.equal(globalStatus('#E_NEED_LOGIN\n'), 'E_NEED_LOGIN');
  assert.equal(globalStatus('  #S_OK\r\nIDALToken=x'), 'S_OK');
  assert.equal(globalStatus('#A1\tS_OK\n192\t5'), undefined);
});

test('an EasyCon answer: units as is, integers strict, linear on a large input', () => {
  const xml =
    '<PCO><ANALOG><VARIABLE><INDEX>1</INDEX><VALUE>4.5</VALUE></VARIABLE>' +
    '<VARIABLE><INDEX>38</INDEX><VALUE>bad</VALUE></VARIABLE></ANALOG>' +
    '<INTEGER><VARIABLE><INDEX>30</INDEX><VALUE>1</VALUE></VARIABLE>' +
    '<VARIABLE><INDEX>32</INDEX><VALUE>1.5</VALUE></VARIABLE></INTEGER></PCO>';
  const tags = parseEasycon(xml, ['A1', 'A38', 'I30', 'I32', 'I51']);
  assert.deepEqual(tags.get('A1'), { status: 'ok', value: 4.5 });
  assert.deepEqual(tags.get('A38'), { status: 'error' });
  assert.deepEqual(tags.get('I30'), { status: 'ok', value: 1 });
  assert.deepEqual(tags.get('I32'), { status: 'error' });
  assert.deepEqual(tags.get('I51'), { status: 'missing' });
  const big = `<ANALOG>${'<INDEX>'.repeat(9000)}</ANALOG>`;
  const started = performance.now();
  parseEasycon(big, ['A1']);
  assert.ok(performance.now() - started < 200);
});

test('cookies: name=value pairs only, bounded', () => {
  const headers = new Map([
    ['set-cookie', ['IDALToken=abc123; path=/', 'bad cookie', `x=${'a'.repeat(600)}`]],
  ]);
  assert.equal(cookiesOf(headers), 'IDALToken=abc123');
  assert.equal(cookiesOf(new Map()), undefined);
});

test('HTTP answers: chunked, content-length, malformed, oversized', () => {
  const ok = parseResponse(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc'), false);
  assert.equal(ok.body, 'abc');
  const chunked = parseResponse(
    Buffer.from(
      'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n2\r\nab\r\n1\r\nc\r\n0\r\n\r\n',
    ),
    false,
  );
  assert.equal(chunked.body, 'abc');
  assert.equal(
    parseResponse(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nabc'), false),
    undefined,
  );
  assert.throws(
    () => parseResponse(Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 9\r\n\r\nabc'), true),
    {
      kind: ERROR_KINDS.CLOSED,
    },
  );
  assert.throws(() => parseResponse(Buffer.from('SSH-2.0\r\n\r\n'), false), {
    kind: ERROR_KINDS.PROTOCOL,
  });
  assert.throws(
    () =>
      parseResponse(
        Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${LIMITS.bodyBytes + 1}\r\n\r\n`),
        false,
      ),
    { kind: ERROR_KINDS.TOO_LARGE },
  );
  assert.throws(() => parseResponse(Buffer.alloc(LIMITS.headerBytes + 1, 0x41), false), {
    kind: ERROR_KINDS.TOO_LARGE,
  });
});

/** A socket that connects and then streams `chunks` of an answer. */
function streamingSocket(onWrite) {
  const s = new EventEmitter();
  s.setNoDelay = () => s;
  s.destroyed = false;
  s.destroy = () => {
    s.destroyed = true;
  };
  s.write = (text) => onWrite(s, text);
  setImmediate(() => s.emit('connect'));
  return s;
}

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r));
};

test('an endless answer is cut before it is read whole', async () => {
  const clock = testClock();
  let pushed = 0;
  const request = httpGet({
    host: 'pump',
    port: 80,
    path: '/cgi/readTags',
    monotonic: clock.monotonic,
    timers: clock.timers,
    connect: () =>
      streamingSocket((s) => {
        s.emit('data', Buffer.from('HTTP/1.1 200 OK\r\n\r\n'));
        while (!s.destroyed && pushed < 1000) {
          pushed += 1;
          s.emit('data', Buffer.alloc(4096, 0x20));
        }
      }),
  });
  await flush();
  await assert.rejects(request.promise, { kind: ERROR_KINDS.TOO_LARGE, sent: true });
  assert.ok(pushed * 4096 <= LIMITS.headerBytes + LIMITS.bodyBytes + 4096);
});

test('beforeSend runs right before the first byte; throwing sends nothing', async () => {
  const clock = testClock();
  const written = [];
  const request = httpGet({
    host: 'pump',
    port: 80,
    path: '/x',
    monotonic: clock.monotonic,
    timers: clock.timers,
    beforeSend: () => {
      throw new Error('option off');
    },
    connect: () => streamingSocket((s, text) => written.push(text)),
  });
  await flush();
  await assert.rejects(
    request.promise,
    (err) => err.beforeSend === true && err.message === 'option off',
  );
  assert.equal(written.length, 0);
});

test('a silent device: timeout after the request left (sent), the request and its headers never in the error', async () => {
  const clock = testClock();
  const request = httpGet({
    host: 'pump',
    port: 80,
    path: '/cgi/login?username=waterkotte&password=secret',
    monotonic: clock.monotonic,
    timers: clock.timers,
    headers: { Cookie: 'IDALToken=tok' },
    answerBy: clock.monotonic() + 1000,
    connect: () => streamingSocket(() => {}),
  });
  await flush();
  await clock.advance(1100);
  await assert.rejects(request.promise, (err) => {
    assert.equal(err.kind, ERROR_KINDS.TIMEOUT);
    assert.equal(err.sent, true);
    assert.doesNotMatch(`${err.message} ${err.stack}`, /secret|tok/);
    return true;
  });
});
