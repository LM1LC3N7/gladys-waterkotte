// -----------------------------------------------------------------------------
// The configuration: the manifest `config_schema` values, normalized so the
// rest of the code never deals with strings typed in a form. The password
// is never logged, never shown, never written to /data: only `fingerprint`
// (8 bits of a salted hash) is kept to notice that it changed after a
// refusal.
// -----------------------------------------------------------------------------

import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
import { DEFAULT_PORT, DEFAULT_USERNAME, DHW_CAP, POLL_INTERVAL, SYSTEMS } from './constants.js';

/** Defaults, mirrored by the manifest (checked by test/manifest.test.js). The password has none. */
export const DEFAULT_CONFIG = {
  address: '',
  system: SYSTEMS.ECOTOUCH,
  username: DEFAULT_USERNAME,
  allow_commands: false,
  dhw_max_temperature: DHW_CAP.default,
  poll_interval: POLL_INTERVAL.default,
  language: 'fr',
};
const KEYS = [...Object.keys(DEFAULT_CONFIG), 'password'];

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i;
/** Credentials: 1 to 64 bytes, no control character (CR, LF, tab, DEL...). */
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const CREDENTIAL_BYTES = 64;

/**
 * The address of the heat pump typed by the user: an IPv4 address or a host
 * name, with an optional port (80 by default). A pasted http:// URL is
 * reduced to its host and port. Never a broadcast, multicast or 0.0.0.0.
 * @returns {{ host: string, port: number } | undefined} undefined when invalid or empty.
 */
export function parseAddress(raw) {
  let text = String(raw ?? '')
    .trim()
    .toLowerCase();
  text = text.replace(/^http:\/\//, '').replace(/[/?#].*$/, '');
  if (text === '' || text.length > 260) {
    return undefined;
  }
  const match = text.match(/^([^:@\s]+)(?::(\d{1,5}))?$/);
  if (!match) {
    return undefined;
  }
  const host = match[1];
  const port = match[2] === undefined ? DEFAULT_PORT : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65535 || host.length > 253) {
    return undefined;
  }
  if (isIP(host) === 4) {
    const [a, , , d] = host.split('.').map(Number);
    if (a === 0 || a >= 224 || d === 255) {
      return undefined;
    }
    return { host, port };
  }
  if (/^[\d.]+$/.test(host)) {
    return undefined;
  }
  return host.split('.').every((label) => LABEL.test(label)) ? { host, port } : undefined;
}

export const addressKey = ({ host, port }) => (port === DEFAULT_PORT ? host : `${host}:${port}`);

/** Only `true` (or the text "true") allows: anything else, missing included, refuses. */
const strictTrue = (value) => value === true || value === 'true';

/** A number typed in the form: a finite number, or undefined ('' and null are not 0). */
function numberOf(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) {
    return Number(value);
  }
  return undefined;
}

/**
 * The hot water ceiling: whole degrees within DHW_CAP, else the default
 * (55 °C). Never above DHW_CAP.max, whatever was typed.
 */
export function dhwCapOf(value) {
  const number = numberOf(value);
  if (number === undefined) {
    return DHW_CAP.default;
  }
  return Math.min(DHW_CAP.max, Math.max(DHW_CAP.min, Math.floor(number)));
}

/** A credential typed in the form: a text of 1 to 64 bytes without control character, else undefined. */
function credentialOf(value) {
  if (typeof value !== 'string' || value === '') {
    return undefined;
  }
  if (CONTROL.test(value) || Buffer.byteLength(value, 'utf8') > CREDENTIAL_BYTES) {
    return null;
  }
  return value;
}

/** 8 bits of a salted hash of the credentials: tells a change, never the password. */
export function fingerprint(salt, username, password) {
  const hash = createHash('sha256').update(`${salt}\n${username}\n${password}`).digest();
  return hash[0];
}

export function normalizeConfig(raw = {}) {
  const c = { ...DEFAULT_CONFIG, password: undefined };
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (KEYS.includes(key) && value != null) {
      c[key] = value;
    }
  }
  const typed = String(c.address ?? '').trim();
  const address = parseAddress(typed);
  const interval = numberOf(c.poll_interval);
  const system = c.system === SYSTEMS.EASYCON ? SYSTEMS.EASYCON : SYSTEMS.ECOTOUCH;
  const username = credentialOf(typeof c.username === 'string' ? c.username.trim() : c.username);
  const password = credentialOf(c.password);
  let credentials;
  /** Why the credentials cannot be used: 'missing', 'noUser', 'invalid'. */
  let credentialsError;
  if (username === null || password === null) {
    credentialsError = 'invalid';
  } else if (password !== undefined && username === undefined) {
    // A password without a user is refused, never sent with a guessed user.
    credentialsError = 'noUser';
  } else if (password === undefined) {
    // EcoTouch always logs in; EasyCon may run without authentication.
    credentialsError = system === SYSTEMS.ECOTOUCH ? 'missing' : undefined;
  } else {
    credentials = { username, password };
  }
  return {
    address,
    /** The address typed is not valid (never shown: it may carry a password). */
    invalid: typed !== '' && !address ? true : undefined,
    system,
    credentials,
    credentialsError,
    allowCommands: strictTrue(c.allow_commands),
    dhwCap: dhwCapOf(c.dhw_max_temperature),
    pollInterval:
      interval === undefined
        ? POLL_INTERVAL.default
        : Math.min(POLL_INTERVAL.max, Math.max(POLL_INTERVAL.min, Math.round(interval))),
    language: c.language === 'en' ? 'en' : 'fr',
  };
}

/** What restarts the client: address, system, credentials, interval. */
export function connectionKey(config) {
  return JSON.stringify([
    config.address ?? null,
    config.invalid ?? null,
    config.system,
    config.credentials?.username ?? null,
    // The password itself is compared, never stored outside the process.
    config.credentials?.password ?? null,
    config.credentialsError ?? null,
    config.pollInterval,
  ]);
}
