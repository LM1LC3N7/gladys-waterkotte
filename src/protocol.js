// -----------------------------------------------------------------------------
// The two web interfaces of the Waterkotte controllers (pure functions), as
// ha-waterkotte 2026.10.7 (pywaterkotte_ha/__init__.py) reads them:
//
// EcoTouch: GET /cgi/login?username=&password= answers "#S_OK" and a session
// cookie (IDALToken), or "#E_PASS_DONT_MATCH" / "#E_TOO_MANY_USERS". Then
// GET /cgi/readTags?n=2&t1=A1&t2=I30&_=<ms> answers, per tag,
//     #A1<TAB>S_OK
//     192<TAB>45
// and /cgi/writeTags?returnValue=true&rnd=<ms>&n=1&t1=I30&v1=0 the same for
// what was written. "#E_NEED_LOGIN" means the session is gone. Analog tags
// (A) carry tenths of their unit; integer tags (I) an integer.
//
// EasyCon (older): GET /config/xml.cgi?A|1|38|I|30|115 with HTTP Basic auth
// answers an XML tree <ANALOG><...><INDEX>1</INDEX><VALUE>4.5</VALUE>... in
// the unit itself. Read only in this integration.
//
// Everything is bounded and linear: answers above LIMITS.bodyBytes never get
// here, a value is a plain decimal of a few digits or it is unknown.
// -----------------------------------------------------------------------------

export const GLOBAL = {
  OK: 'S_OK',
  NEED_LOGIN: 'E_NEED_LOGIN',
  TOO_MANY_USERS: 'E_TOO_MANY_USERS',
  BAD_PASSWORD: 'E_PASS_DONT_MATCH',
};

const TAG = /^[AID]\d{1,5}$/;

export const isTag = (tag) => typeof tag === 'string' && TAG.test(tag);

/** The value of a tag as the controller writes it: analog in tenths, integer as is. */
export function decodeEcotouch(tag, raw) {
  if (typeof raw !== 'string') {
    return undefined;
  }
  if (tag[0] === 'A') {
    return /^[-+]?\d{1,7}(\.\d{1,4})?$/.test(raw) ? Number(raw) / 10 : undefined;
  }
  // An integer, possibly written "12.0" by some firmwares; never a fraction.
  return /^[-+]?\d{1,7}(\.0{1,4})?$/.test(raw) ? Math.trunc(Number(raw)) : undefined;
}

/** What a written value becomes on the wire: tenths for an analog tag, an integer otherwise. */
export function encodeEcotouch(tag, value) {
  return tag[0] === 'A' ? String(Math.round(value * 10)) : String(Math.trunc(value));
}

export const loginPath = (username, password) =>
  `/cgi/login?username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;

export const logoutPath = () => '/cgi/logout';

export function readPath(tags, stamp) {
  const parts = [`n=${tags.length}`];
  tags.forEach((tag, i) => parts.push(`t${i + 1}=${tag}`));
  parts.push(`_=${Math.trunc(stamp)}`);
  return `/cgi/readTags?${parts.join('&')}`;
}

/** `entries`: [[tag, wire value]]; every value written in one request. */
export function writePath(entries, stamp) {
  const parts = [`n=${entries.length}`, 'returnValue=true', `rnd=${Math.trunc(stamp)}`];
  entries.forEach(([tag, value], i) => parts.push(`t${i + 1}=${tag}`, `v${i + 1}=${value}`));
  return `/cgi/writeTags?${parts.join('&')}`;
}

/**
 * The status of the whole answer ("#S_OK", "#E_NEED_LOGIN"...): a body that
 * starts with "#" and a status word (ha-waterkotte: `startswith("#E_NEED_LOGIN")`),
 * compared by prefix, so "#E_NEED_LOGIN_X" is still a lost session. A tag
 * line ("#A1<TAB>...") is not a status.
 */
export function globalStatus(body) {
  const match = /^#([A-Z_]{2,40})(?![0-9A-Z_])/.exec(String(body ?? '').replace(/^\s+/, ''));
  if (!match) {
    return undefined;
  }
  const word = match[1];
  return Object.values(GLOBAL).find((known) => word.startsWith(known)) ?? word;
}

/**
 * The tags of a readTags / writeTags answer: Map tag -> { status, value }.
 * `status` is 'ok' (a value), 'inactive' (E_INACTIVETAG), 'error' (another
 * status, or S_OK without a readable value); a tag asked and absent is
 * 'missing'. Only the asked tags are kept.
 */
export function parseTags(body, tags) {
  const asked = new Set(tags);
  const found = new Map();
  const lines = String(body ?? '').split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const head = /^#([AID]\d{1,5})\t([A-Z_]{1,40})\s*$/.exec(lines[i]);
    if (!head || !asked.has(head[1]) || found.has(head[1])) {
      continue;
    }
    const [, tag, status] = head;
    if (status === 'E_INACTIVETAG') {
      found.set(tag, { status: 'inactive' });
      continue;
    }
    const next = /^\d{1,6}\t(\S{0,24})\s*$/.exec(lines[i + 1] ?? '');
    const value = status === GLOBAL.OK && next ? decodeEcotouch(tag, next[1]) : undefined;
    found.set(tag, value === undefined ? { status: 'error' } : { status: 'ok', value });
    if (next) {
      i += 1;
    }
  }
  for (const tag of tags) {
    if (!found.has(tag)) {
      found.set(tag, { status: 'missing' });
    }
  }
  return found;
}

// --- EasyCon -------------------------------------------------------------------

const SECTIONS = { A: 'ANALOG', I: 'INTEGER', D: 'DIGITAL' };

/** One range per type, from the lowest to the highest index asked (ha-waterkotte). */
export function easyconPath(tags) {
  const ranges = [];
  for (const type of ['D', 'A', 'I']) {
    const indexes = tags.filter((t) => t[0] === type).map((t) => Number(t.slice(1)));
    if (indexes.length > 0) {
      ranges.push(type, Math.min(...indexes), Math.max(...indexes));
    }
  }
  return `/config/xml.cgi?${ranges.join('|')}`;
}

/** The asked tags of an EasyCon XML answer: Map tag -> { status, value }, in the unit itself. */
export function parseEasycon(body, tags) {
  const text = String(body ?? '');
  const found = new Map();
  for (const [type, name] of Object.entries(SECTIONS)) {
    const start = text.indexOf(`<${name}>`);
    const end = start < 0 ? -1 : text.indexOf(`</${name}>`, start);
    if (start < 0 || end < 0) {
      continue;
    }
    const section = text.slice(start, end);
    // Linear: each part runs from one <INDEX> to the next.
    for (const part of section.split('<INDEX>').slice(1)) {
      const index = /^\s*(\d{1,5})\s*<\/INDEX>/.exec(part);
      const value = /<VALUE>\s*([^<\s]{0,24})\s*<\/VALUE>/.exec(part);
      if (!index) {
        continue;
      }
      const tag = `${type}${Number(index[1])}`;
      if (found.has(tag)) {
        continue;
      }
      let number;
      if (value && /^[-+]?\d{1,7}(\.\d{1,4})?$/.test(value[1])) {
        number = Number(value[1]);
        if (type !== 'A' && !Number.isInteger(number)) {
          number = undefined;
        }
      }
      found.set(tag, number === undefined ? { status: 'error' } : { status: 'ok', value: number });
    }
  }
  const result = new Map();
  for (const tag of tags) {
    result.set(tag, found.get(tag) ?? { status: 'missing' });
  }
  return result;
}
