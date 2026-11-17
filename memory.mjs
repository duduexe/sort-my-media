// Sort my Media: what Claude already knows about a file, shared by all projects.
// Claude's short description, the words spoken, the tags and the project name of every file it looked at closely.
// A file is recognised by its content (its size plus the first and last 256 KB), so it is still known
// after the app moved it or after a rename. Kept in .cache/known.json, never next to her files.
import fs from 'node:fs';
import crypto from 'node:crypto';

let FILE = '';
let memo = null;
const load = () => {
  if (!memo) {
    try {
      memo = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      memo = {};
    }
    memo.byKey = memo.byKey || {};
    memo.byPath = memo.byPath || {};
  }
  return memo;
};
let saveT = null;
const save = () => {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    try {
      fs.writeFileSync(FILE, JSON.stringify(memo));
    } catch {
      // only a speed-up
    }
  }, 400);
};
export const setup = (cache) => {
  FILE = `${cache}/known.json`;
};

const PART = 256 * 1024;
// content key: size + start + end of the file (reads at most 512 KB, never the whole video)
const keyOf = (p, st) => {
  const h = crypto.createHash('sha1');
  h.update(String(st.size));
  const fd = fs.openSync(p, 'r');
  try {
    const a = Buffer.alloc(Math.min(PART, st.size));
    fs.readSync(fd, a, 0, a.length, 0);
    h.update(a);
    if (st.size > PART * 2) {
      const b = Buffer.alloc(PART);
      fs.readSync(fd, b, 0, PART, st.size - PART);
      h.update(b);
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
};
const stamp = (st) => `${st.size}|${Math.round(st.mtimeMs)}`;

// quick: only when this exact file (same place, size and date) was seen before
export const recallQuick = (p) => {
  const m = load();
  const hit = m.byPath[p];
  if (!hit) return null;
  try {
    if (hit.s !== stamp(fs.statSync(p))) return null;
  } catch {
    return null;
  }
  return m.byKey[hit.k] || null;
};

// full: also finds the file after it was moved or renamed (reads its start and end)
export const recall = (p) => {
  const q = recallQuick(p);
  if (q) return q;
  const m = load();
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return null;
    const k = keyOf(p, st);
    m.byPath[p] = {k, s: stamp(st)};
    save();
    return m.byKey[k] || null;
  } catch {
    return null;
  }
};

// entries: [{path, summary, words, tags, topic, kind, place}] from an analysis or a search
export const remember = (entries, from = '') => {
  const m = load();
  let n = 0;
  for (const e of entries || []) {
    if (!e || !e.path || !String(e.summary || '').trim()) continue;
    try {
      const st = fs.statSync(e.path);
      if (!st.isFile()) continue;
      const hit = m.byPath[e.path];
      const k = hit && hit.s === stamp(st) ? hit.k : keyOf(e.path, st);
      m.byPath[e.path] = {k, s: stamp(st)};
      const old = m.byKey[k] || {};
      m.byKey[k] = {
        summary: String(e.summary).slice(0, 240),
        words: String(e.words || old.words || '').slice(0, 600),
        tags: Array.isArray(e.tags) && e.tags.length ? e.tags.slice(0, 6) : old.tags || [],
        topic: e.topic || old.topic || '',
        place: e.place || old.place || '',
        kind: e.kind || old.kind || '',
        at: Date.now(),
        from,
      };
      n++;
    } catch {
      // a file that went away
    }
  }
  if (n) save();
  return n;
};

export const size = () => Object.keys(load().byKey).length;
