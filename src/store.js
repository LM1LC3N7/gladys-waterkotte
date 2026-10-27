// -----------------------------------------------------------------------------
// The state kept in /data (the only writable place of the container): the
// stops not confirmed yet, the refused credentials (8 bits of a salted hash,
// never the password), the pause after "too many users" or a 5xx, and the
// time of the last attempt, so that a restart neither forgets a stop nor
// reads too soon. Never a password, a cookie nor an address.
//
// A small JSON file written through a temporary file and a rename, one save
// after the other. A file that exists but cannot be read is NOT empty:
// `load()` says so (`readable: false`) and the app then never overwrites it.
// -----------------------------------------------------------------------------

import { readFileSync, statSync } from 'node:fs';
import { rename, writeFile } from 'node:fs/promises';

export const DEFAULT_STATE_FILE = '/data/waterkotte-state.json';
/** A larger file is not ours. */
const MAX_STATE_BYTES = 64 * 1024;

export function createFileStore(file = DEFAULT_STATE_FILE) {
  let queue = Promise.resolve();
  const write = async (data) => {
    const tmp = `${file}.tmp`;
    await writeFile(tmp, JSON.stringify(data), 'utf8');
    await rename(tmp, file);
  };
  return {
    /** `{ data, readable }`: a missing file is readable and empty; anything else unreadable. */
    load() {
      try {
        if (statSync(file).size > MAX_STATE_BYTES) {
          return { data: {}, readable: false };
        }
        const data = JSON.parse(readFileSync(file, 'utf8'));
        return data && typeof data === 'object' && !Array.isArray(data)
          ? { data, readable: true }
          : { data: {}, readable: false };
      } catch (err) {
        return { data: {}, readable: err?.code === 'ENOENT' };
      }
    },
    save(data) {
      const job = queue.then(
        () => write(data),
        () => write(data),
      );
      queue = job.catch(() => {});
      return job;
    },
  };
}

/** The same in memory (tests): `fail` makes the saves fail, `readable: false` the load. */
export function createMemoryStore(initial = {}, { readable = true } = {}) {
  let data = structuredClone(initial);
  const store = {
    fail: false,
    saves: 0,
    load: () => ({ data: structuredClone(data), readable }),
    async save(next) {
      if (store.fail) {
        throw new Error('disk full');
      }
      store.saves += 1;
      data = structuredClone(next);
    },
    get data() {
      return data;
    },
  };
  return store;
}
