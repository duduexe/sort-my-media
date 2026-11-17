// Sort my Media: what the Mac already knows about each file (BUILD_PLAN 7.10 Advanced options, 7.7 sources).
// Date taken, length, download address ("Where from"), screenshot or not, camera model, copyright.
// Read with one `mdls` call per 300 files and kept in .cache/meta.json, so the step 3 counts update at once.
import fs from 'node:fs';
import path from 'node:path';
import {execFile} from 'node:child_process';

let FILE = '';
let memo = null;
export const setup = (cache) => {
  FILE = path.join(cache, 'meta.json');
};
const load = () => {
  if (!memo) {
    try {
      memo = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    } catch {
      memo = {};
    }
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
  }, 500);
};
// mdls prints the values in alphabetical order of the names, whatever order they are asked in
const NAMES = ['kMDItemAcquisitionModel', 'kMDItemContentCreationDate', 'kMDItemCopyright', 'kMDItemDurationSeconds', 'kMDItemIsScreenCapture', 'kMDItemWhereFroms'].sort();
const at = (v, name) => v[NAMES.indexOf(name)];
const run = (files) =>
  new Promise((resolve) => {
    const args = ['-raw', '-nullMarker', '\u0001'];
    NAMES.forEach((n) => args.push('-name', n));
    execFile('mdls', args.concat(files), {maxBuffer: 6e7, timeout: 180000}, (err, out) => resolve(String(out || '').split('\u0000')));
  });
const list = (raw) => {
  if (!raw || raw === '\u0001') return [];
  return (raw.match(/"([^"]*)"/g) || []).map((x) => x.slice(1, -1));
};

// files: full paths with their stat. Returns {path: {date, secs, from: [urls], shot, camera, copyright}}
export const metaFor = async (items) => {
  const m = load();
  const out = {};
  const todo = [];
  for (const it of items) {
    const k = `${it.path}|${it.size}|${it.mtime}`;
    if (m[k]) out[it.path] = m[k];
    else todo.push({...it, k});
  }
  for (let i = 0; i < todo.length; i += 300) {
    const part = todo.slice(i, i + 300);
    const vals = await run(part.map((p) => p.path));
    part.forEach((p, j) => {
      const v = vals.slice(j * NAMES.length, (j + 1) * NAMES.length).map((x) => (x === '\u0001' || x === undefined ? '' : x.trim()));
      let date = '';
      const created = at(v, 'kMDItemContentCreationDate');
      if (created) {
        const d = new Date(created.replace(' +0000', 'Z').replace(' ', 'T'));
        if (!isNaN(d) && d.getFullYear() > 1990) date = d.toISOString(); // 1980 or 1970 are empty dates from downloads and zips
      }
      if (!date) date = new Date(p.birth || p.mtime).toISOString();
      const secs = at(v, 'kMDItemDurationSeconds');
      const cam = at(v, 'kMDItemAcquisitionModel');
      const copy = at(v, 'kMDItemCopyright');
      const rec = {date, secs: secs ? Math.round(parseFloat(secs) * 10) / 10 : 0, from: list(at(v, 'kMDItemWhereFroms')), shot: at(v, 'kMDItemIsScreenCapture') === '1', camera: cam ? cam.replace(/^"|"$/g, '') : '', copyright: copy ? copy.replace(/^"|"$/g, '') : ''};
      m[p.k] = rec;
      out[p.path] = rec;
    });
  }
  if (todo.length) save();
  return out;
};

// Where a file came from, in plain words: Phone, Screen recording or Download.
export const originOf = (name, rec) => {
  const s = name.toLowerCase();
  if (/screen ?recording|screenrecording|rpreplay/.test(s)) return 'Screen recording';
  if (rec && rec.from && rec.from.length) return 'Download';
  if ((rec && rec.camera) || /^(img|vid|pxl|mvimg|dsc|dji|gopr)[_-]?\d|^\d{8}_\d{6}|\.heic$/.test(s)) return 'Phone';
  return rec ? 'Unknown' : 'Download';
};

// The "Advanced options" of step 3 (all optional). Returns {used: [...], left: [{rel, why}]}.
export const DEFAULTS = {kinds: {pic: true, vid: true, snd: true, oth: true}, noShots: false, noGifs: false, date: 'any', from: '', to: '', minMB: '', maxMB: '', minSecs: '', origin: '', nameHas: '', nameNot: '', sub: true, skipHidden: true, skipSorted: true, fresh: false};
export const cleanOpts = (o) => {
  const d = JSON.parse(JSON.stringify(DEFAULTS));
  if (!o || typeof o !== 'object') return d;
  for (const k of ['pic', 'vid', 'snd', 'oth']) if (o.kinds && typeof o.kinds[k] === 'boolean') d.kinds[k] = o.kinds[k];
  for (const k of ['noShots', 'noGifs']) d[k] = !!o[k];
  for (const k of ['sub', 'skipHidden', 'skipSorted', 'fresh']) if (typeof o[k] === 'boolean') d[k] = o[k];
  if (['any', '30', 'year', 'custom'].includes(o.date)) d.date = o.date;
  for (const k of ['from', 'to']) if (/^\d{4}-\d\d-\d\d$/.test(String(o[k] || ''))) d[k] = o[k];
  for (const k of ['minMB', 'maxMB', 'minSecs']) if (o[k] !== '' && o[k] != null && isFinite(Number(o[k]))) d[k] = Number(o[k]);
  if (['', 'Phone', 'Screen recording', 'Download'].includes(o.origin)) d.origin = o.origin;
  for (const k of ['nameHas', 'nameNot']) d[k] = String(o[k] || '').trim().slice(0, 60);
  return d;
};
export const needsMeta = (o) => o.noShots || o.date !== 'any' || o.minSecs !== '' || o.origin !== '';

// files: [{root, rel, t, bytes}] (the scan); recs: metaFor result (only needed when needsMeta)
export const applyOpts = (files, o, recs = {}) => {
  const used = [];
  const left = [];
  const now = Date.now();
  const yearStart = new Date(new Date().getFullYear(), 0, 1).getTime();
  for (const f of files) {
    const name = path.basename(f.rel);
    const low = name.toLowerCase();
    const rec = recs[path.join(f.root, f.rel)] || null;
    let why = '';
    if (!o.kinds[f.t]) why = f.t === 'pic' ? 'pictures are not ticked' : f.t === 'vid' ? 'videos are not ticked' : f.t === 'snd' ? 'sounds are not ticked' : 'other files are not ticked';
    else if (o.noGifs && low.endsWith('.gif')) why = 'no GIFs';
    else if (o.noShots && f.t === 'pic' && ((rec && rec.shot) || /^(screenshot|screen shot|capture d.?écran)/.test(low))) why = 'no screenshots';
    else if (o.minMB !== '' && f.bytes < o.minMB * 1e6) why = `smaller than ${o.minMB} MB`;
    else if (o.maxMB !== '' && f.bytes > o.maxMB * 1e6) why = `larger than ${o.maxMB} MB`;
    else if (o.minSecs !== '' && f.t === 'vid' && rec && rec.secs && rec.secs < o.minSecs) why = `clip shorter than ${o.minSecs} seconds`;
    else if (o.nameHas && !low.includes(o.nameHas.toLowerCase())) why = `name does not contain "${o.nameHas}"`;
    else if (o.nameNot && low.includes(o.nameNot.toLowerCase())) why = `name contains "${o.nameNot}"`;
    else if (o.origin && rec && originOf(name, rec) !== o.origin) why = `not from ${o.origin === 'Phone' ? 'the phone' : o.origin === 'Download' ? 'a download' : 'a screen recording'}`;
    else if (o.date !== 'any' && rec) {
      const t = new Date(rec.date).getTime();
      if (o.date === '30' && t < now - 30 * 864e5) why = 'older than 30 days';
      if (o.date === 'year' && t < yearStart) why = 'not from this year';
      if (o.date === 'custom') {
        if (o.from && t < new Date(`${o.from}T00:00:00`).getTime()) why = `before ${o.from}`;
        if (o.to && t > new Date(`${o.to}T23:59:59`).getTime()) why = `after ${o.to}`;
      }
    }
    if (why) left.push({rel: f.rel, why});
    else used.push(f);
  }
  return {used, left};
};
