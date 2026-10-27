import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  connectionKey,
  dhwCapOf,
  fingerprint,
  normalizeConfig,
  parseAddress,
} from '../src/config.js';

test('addresses: IPv4 or host, port 80 by default, never broadcast nor multicast', () => {
  assert.deepEqual(parseAddress('192.168.1.50'), { host: '192.168.1.50', port: 80 });
  assert.deepEqual(parseAddress('http://192.168.1.50:8080/index.html'), {
    host: '192.168.1.50',
    port: 8080,
  });
  assert.deepEqual(parseAddress('Pump.local'), { host: 'pump.local', port: 80 });
  for (const bad of [
    '',
    '0.0.0.0',
    '255.255.255.255',
    '192.168.1.255',
    '224.0.0.1',
    '1.2.3',
    'a b',
    'user@host',
    'h:0',
    'h:70000',
    'https://x',
    'x\r\ny',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
});

test('credentials: a password without a user is refused; control characters refused; EcoTouch needs a password', () => {
  assert.equal(normalizeConfig({ address: '1.2.3.4' }).credentialsError, 'missing');
  assert.equal(
    normalizeConfig({ address: '1.2.3.4', system: 'easycon' }).credentialsError,
    undefined,
  );
  assert.equal(normalizeConfig({ password: 'p', username: '' }).credentialsError, 'noUser');
  assert.equal(normalizeConfig({ password: 'p\r\nX: y' }).credentialsError, 'invalid');
  assert.equal(normalizeConfig({ password: 'é'.repeat(33) }).credentialsError, 'invalid');
  assert.deepEqual(normalizeConfig({ password: 'p' }).credentials, {
    username: 'waterkotte',
    password: 'p',
  });
});

test('options: strict true, ceiling 40-60 rounded down, interval bounded', () => {
  assert.equal(normalizeConfig({ allow_commands: 'yes' }).allowCommands, false);
  assert.equal(normalizeConfig({ allow_commands: true }).allowCommands, true);
  assert.equal(dhwCapOf(''), 55);
  assert.equal(dhwCapOf(null), 55);
  assert.equal(dhwCapOf(80), 60);
  assert.equal(dhwCapOf(59.9), 59);
  assert.equal(dhwCapOf(10), 40);
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.equal(normalizeConfig({ poll_interval: '' }).pollInterval, 60);
});

test('the fingerprint is 8 bits and salted; the key changes with the password', () => {
  const fp = fingerprint('00'.repeat(16), 'waterkotte', 'secret');
  assert.ok(Number.isInteger(fp) && fp >= 0 && fp <= 255);
  assert.notEqual(
    connectionKey(normalizeConfig({ password: 'a' })),
    connectionKey(normalizeConfig({ password: 'b' })),
  );
});
