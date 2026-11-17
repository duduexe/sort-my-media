// Sort my Media: finds duplicates (BUILD_PLAN 3, Remove duplicates). Only reads her files.
// - Exact copies: same size, then the same SHA-256 fingerprint. These get ticked for removal.
// - Look-alikes: pictures and videos whose small grey preview (9 x 8 points, "dHash") is almost the same.
//   These are shown but not ticked.
// Fingerprints are kept in .cache so a second check is quick.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';

let CACHE = '';
let thumbOf = async () => '';
export const setup = (opts) => {
  CACHE = opts.cache;
  thumbOf = opts.thumb;
};
const memoFile = () => path.join(CACHE, 'fingerprints.json');
let memo = null;
const loadMemo = () => {
  if (!memo) {
    try {
      memo = JSON.parse(fs.readFileSync(memoFile(), 'utf8'));
    } catch {
      memo = {};
    }
  }
  return memo;
};
const saveMemo = () => {
  try {
    fs.writeFileSync(memoFile(), JSON.stringify(memo));
  } catch {
    // only a speed-up
  }
};
const keyOf = (p, st) => `${p}|${st.size}|${Math.round(st.mtimeMs)}`;

const sha = (p) =>
  new Promise((resolve) => {
    const h = crypto.createHash('sha256');
    fs.createReadStream(p)
      .on('data', (b) => h.update(b))
      .on('end', () => resolve(h.digest('hex')))
      .on('error', () => resolve(''));
  });

// dHash from a 9 x 8 BMP made by sips from the small preview picture.
const dhash = (thumb) =>
  new Promise((resolve) => {
    const out = path.join(CACHE, `dh_${crypto.createHash('sha1').update(thumb).digest('hex')}.bmp`);
    execFile('sips', ['-s', 'format', 'bmp', '-z', '8', '9', thumb, '--out', out], {timeout: 20000}, () => {
      try {
        const b = fs.readFileSync(out);
        const off = b.readUInt32LE(10);
        const w = b.readInt32LE(18);
        const hRaw = b.readInt32LE(22);
        const h = Math.abs(hRaw);
        const bpp = b.readUInt16LE(28) / 8;
        const row = Math.ceil((w * bpp) / 4) * 4;
        if (w !== 9 || h !== 8 || bpp < 3) return resolve('');
        let bits = '';
        for (let y = 0; y < 8; y++) {
          const ry = hRaw > 0 ? 7 - y : y;
          const grey = [];
          for (let x = 0; x < 9; x++) {
            const i = off + ry * row + x * bpp;
            grey.push(0.114 * b[i] + 0.587 * b[i + 1] + 0.299 * b[i + 2]);
          }
          for (let x = 0; x < 8; x++) bits += grey[x] > grey[x + 1] ? '1' : '0';
        }
        resolve(bits);
      } catch {
        resolve('');
      }
    });
  });
const distance = (a, b) => {
  let d = 0;
  for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++;
  return d;
};

// files: [{root, rel, t, bytes}] -> groups [{kind: 'exact'|'similar', why, items: [file]}]
export const findDups = async (files, onStep = () => {}) => {
  const m = loadMemo();
  const groups = [];
  const inExact = new Set();
  // 1. exact copies
  const bySize = new Map();
  files.forEach((f) => {
    if (!f.bytes) return;
    const l = bySize.get(f.bytes) || [];
    l.push(f);
    bySize.set(f.bytes, l);
  });
  for (const list of bySize.values()) {
    if (list.length < 2) continue;
    const byHash = new Map();
    for (const f of list) {
      const p = path.join(f.root, f.rel);
      let st;
      try {
        st = fs.statSync(p);
      } catch {
        continue;
      }
      const k = `sha|${keyOf(p, st)}`;
      if (!m[k]) m[k] = await sha(p);
      if (!m[k]) continue;
      const l = byHash.get(m[k]) || [];
      l.push(f);
      byHash.set(m[k], l);
    }
    for (const l of byHash.values())
      if (l.length > 1) {
        l.forEach((f) => inExact.add(f));
        const kind = l[0].t;
        groups.push({kind: 'exact', why: kind === 'vid' ? 'Same video, saved more than once' : kind === 'snd' ? 'Same sound, saved more than once' : kind === 'pic' ? 'Same picture, saved more than once' : 'Same file, saved more than once', items: l});
      }
  }
  onStep('look');
  // 2. look-alikes (pictures and videos only)
  const looks = [];
  for (const f of files) {
    if (inExact.has(f)) continue;
    if (!((f.t === 'pic' && !/\.svg$/i.test(f.rel)) || f.t === 'vid')) continue;
    const p = path.join(f.root, f.rel);
    let st;
    try {
      st = fs.statSync(p);
    } catch {
      continue;
    }
    const k = `dh|${keyOf(p, st)}`;
    if (m[k] === undefined) {
      const th = await thumbOf(p, st);
      m[k] = th ? await dhash(th) : '';
    }
    if (m[k]) looks.push({f, h: m[k]});
  }
  saveMemo();
  const parent = looks.map((_, i) => i);
  const top = (i) => (parent[i] === i ? i : (parent[i] = top(parent[i])));
  for (let i = 0; i < looks.length; i++)
    for (let j = i + 1; j < looks.length; j++) {
      if (looks[i].f.t !== looks[j].f.t) continue;
      // nearly blank pictures (one colour) look alike without being alike: skip them
      if (/^0+$|^1+$/.test(looks[i].h) || /^0+$|^1+$/.test(looks[j].h)) continue;
      if (distance(looks[i].h, looks[j].h) <= 5) parent[top(i)] = top(j);
    }
  const sets = new Map();
  looks.forEach((x, i) => {
    const r = top(i);
    const l = sets.get(r) || [];
    l.push(x.f);
    sets.set(r, l);
  });
  for (const l of sets.values()) if (l.length > 1) groups.push({kind: 'similar', why: l[0].t === 'vid' ? 'Start almost the same (two takes or an edit)' : 'Look almost the same (an edit or a burst photo)', items: l});
  return groups;
};
