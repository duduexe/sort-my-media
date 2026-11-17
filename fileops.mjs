// Sort my Media: the only code that moves files (BUILD_PLAN 3 and 7.1).
// - Approve sorting: move or copy each file into its folder (the three output choices of step 3).
// - Media Library: move a file to another folder, or to the Bin.
// - Remove duplicates: chosen copies to the Bin.
// Every action is written to the project's undo_log.json and to "where files went.txt", so Undo and Revert put
// everything back. Nothing is ever deleted: the Bin is the macOS Trash, and reverting a copy moves the copy to the Bin.
// File contents and file names are never changed (a number is added only when a name is already taken).
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

const TRASH = path.join(os.homedir(), '.Trash');
export const MARK = '.sortmymedia'; // small hidden note in each top folder this app made, so it is not sorted twice
const NOTE = 'where files went.txt';

let projectDir = () => '';
let known = new Set();
export const setup = (opts) => {
  projectDir = opts.projectDir;
  known = opts.known;
};

const readJson = (f, fb) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return fb;
  }
};
const writeJson = (f, d) => {
  fs.writeFileSync(`${f}.saving`, JSON.stringify(d, null, 1));
  fs.renameSync(`${f}.saving`, f);
};
const stamp = () => new Date().toISOString().replace(/\D/g, '').slice(2, 12);
const now = () => new Date().toLocaleString('en-GB', {dateStyle: 'medium', timeStyle: 'short'});

// Folder names from the plan: no / or :, no dots only, short.
export const safePart = (p) => {
  const s = String(p || '')
    .replace(/[\/:\\]/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 80);
  return s || 'Not sure';
};
// A free name in a folder: "name.jpg", then "name 2.jpg", "name 3.jpg" ...
const freePath = (dir, name) => {
  const ext = path.extname(name);
  const base = name.slice(0, name.length - ext.length);
  let p = path.join(dir, name);
  for (let k = 2; fs.existsSync(p); k++) p = path.join(dir, `${base} ${k}${ext}`);
  return p;
};
const inside = (parent, child) => child === parent || child.startsWith(parent + path.sep);
const isKnownFile = (root, rel) => {
  try {
    const r = fs.realpathSync(root);
    if (![...known].some((k) => inside(k, r))) return '';
    const full = path.resolve(r, rel);
    if (!inside(r, full) || full === r) return '';
    return fs.statSync(full).isFile() ? full : '';
  } catch {
    return '';
  }
};
// Makes the folders that are missing and remembers which ones this app made (for Revert).
const ensureDir = (dir, made) => {
  const missing = [];
  let d = dir;
  while (!fs.existsSync(d)) {
    missing.unshift(d);
    d = path.dirname(d);
  }
  for (const m of missing) {
    fs.mkdirSync(m);
    made.push(m);
  }
};
const move = (from, to) => {
  try {
    fs.renameSync(from, to);
  } catch (e) {
    if (e.code === 'EXDEV') throw new Error('The new place is on another disk. Pick a place on the same disk, or choose "Copy into one new sorted folder".');
    throw e;
  }
};
const copy = (from, to) => {
  fs.copyFileSync(from, to, fs.constants.COPYFILE_EXCL);
  const st = fs.statSync(from);
  fs.utimesSync(to, st.atime, st.mtime); // the copy keeps the date of the original
};
const toTrash = (p) => {
  const t = freePath(TRASH, path.basename(p));
  fs.renameSync(p, t);
  return t;
};

// ---------- the log of each project ----------
const logFile = (uid) => path.join(projectDir(uid), 'undo_log.json');
const libFile = (uid) => path.join(projectDir(uid), 'library.json');
const readLog = (uid) => readJson(logFile(uid), []);
export const library = (uid) => {
  const l = readJson(libFile(uid), null);
  return l && l.files ? l : null;
};
const saveLib = (uid, lib) => writeJson(libFile(uid), lib || {files: null, note: 'Not sorted (reverted or never approved).'});
const addOp = (uid, op) => {
  const log = readLog(uid);
  log.push(op);
  writeJson(logFile(uid), log);
};
// "where files went.txt": in the project folder and in each place files were sorted into.
const note = (uid, bases, lines) => {
  if (!lines.length) return;
  const text = lines.map((l) => `${now()}  ${l}`).join('\n') + '\n';
  const places = new Set([projectDir(uid), ...bases].filter(Boolean));
  for (const b of places) {
    try {
      fs.appendFileSync(path.join(b, NOTE), text);
    } catch {
      // a place that went away: the project copy still has it
    }
  }
};
const newId = () => `${stamp()}_${crypto.randomBytes(3).toString('hex')}`;

// ---------- Approve sorting ----------
// files: [{root, rel, parts: [folder names]}]. mode: inplace | copy | merge.
// add: true adds new files to a library that already exists (Keep sorted).
// It works in small steps and checks stop() between them: "Cancel" while it runs puts back what was already done.
export const approve = async (uid, {mode, newName, outDir, files, add}, {stop = () => false, progress = () => {}} = {}) => {
  if (!projectDir(uid)) return {ok: false, error: 'This sorting project is not there any more.'};
  const old = library(uid);
  if (old && !add) return {ok: false, error: 'This project is already sorted. Use Revert first to sort again.'};
  if (!old && add) return {ok: false, error: 'This project is not sorted yet.'};
  if (old) {
    mode = old.mode;
  }
  let base = '';
  if (mode === 'copy' || mode === 'merge') {
    if (old) base = old.base;
    else {
      let place;
      try {
        place = fs.realpathSync(String(outDir || ''));
      } catch {
        return {ok: false, error: 'I cannot find the place for the new folder. Check it in step 3.'};
      }
      base = path.join(place, safePart(newName || 'All my media'));
    }
    const roots = [...new Set(files.map((f) => f.root))].map((r) => {
      try {
        return fs.realpathSync(r);
      } catch {
        return '';
      }
    }).filter(Boolean);
    if (roots.some((r) => inside(r, base))) return {ok: false, error: 'The new folder is inside a folder you are sorting. Pick another place in step 3.'};
  }
  const items = [];
  const made = [];
  const marks = [];
  const out = [];
  const lines = [];
  const bases = new Set();
  let error = '';
  let cancelled = false;
  try {
    if (base) ensureDir(base, made);
    for (let k = 0; k < files.length; k++) {
      if (k % 10 === 0) {
        await new Promise((r) => setImmediate(r));
        if (stop()) {
          cancelled = true;
          break;
        }
        progress(k, files.length);
      }
      const f = files[k];
      const from = isKnownFile(f.root, f.rel);
      if (!from) continue; // file gone or outside her folders: left alone
      const root = fs.realpathSync(f.root);
      const b = base || root;
      const parts = (f.parts || []).map(safePart);
      const dir = path.join(b, ...parts);
      if (!inside(b, dir)) continue;
      ensureDir(dir, made);
      // in place: a small hidden note in the top folders this app made, so they are skipped next time
      if (!base && parts.length) {
        const top = path.join(root, parts[0]);
        const mk = path.join(top, MARK);
        if (!fs.existsSync(mk) && (made.includes(top) || old)) {
          fs.writeFileSync(mk, 'Made by Sort my Media. Files in this folder are already sorted.\n');
          marks.push(mk);
        }
      }
      const to = freePath(dir, path.basename(from));
      if (mode === 'copy') copy(from, to);
      else move(from, to);
      items.push({op: mode === 'copy' ? 'copy' : 'move', from, to});
      lines.push(`${mode === 'copy' ? 'copied' : 'moved '}  ${from}  ->  ${to}`);
      out.push({from: {root: f.root, rel: f.rel}, root: b, rel: path.relative(b, to), parts});
      bases.add(b);
    }
    progress(files.length, files.length);
  } catch (e) {
    error = String(e && e.message ? e.message : e);
  }
  const op = {id: newId(), type: old ? 'add' : 'sort', at: Date.now(), mode, base, bases: [...bases], items, made, marks};
  if (cancelled) {
    // changed her mind: put back what was already moved, nothing stays half sorted
    const r = undoOp(uid, op, null);
    op.undone = Date.now();
    op.cancelled = true;
    addOp(uid, op);
    note(uid, [...bases], lines.concat(r.lines, ['CANCELLED: the sorting was stopped and every file was put back.']));
    return {ok: false, cancelled: true, error: 'Cancelled. Every file is back where it was.'};
  }
  addOp(uid, op);
  note(uid, [...bases], lines);
  let lib = old;
  if (old) {
    old.files = old.files.concat(out);
    saveLib(uid, old);
  } else if (items.length) {
    lib = {at: Date.now(), mode, base, op: op.id, files: out};
    saveLib(uid, lib);
  }
  bases.forEach((b) => known.add(b));
  if (error) return {ok: false, error: `${error} ${items.length} files were already sorted; Revert puts them back.`, library: items.length ? lib : null, id: op.id};
  return {ok: true, library: lib, id: op.id, added: old ? out.length : undefined};
};

// ---------- Find something specific: collect the matches (copy by default, or move) ----------
// into: an existing folder she picked (the files go inside it, nothing in it is replaced); otherwise a new folder outDir/newName.
export const collect = (uid, {mode, outDir, newName, into, files}) => {
  if (!projectDir(uid)) return {ok: false, error: 'This sorting project is not there any more.'};
  let place;
  let base;
  try {
    if (into) {
      base = fs.realpathSync(String(into));
      if (!fs.statSync(base).isDirectory()) throw new Error('not a folder');
    } else {
      place = fs.realpathSync(String(outDir || ''));
    }
  } catch {
    return {ok: false, error: into ? 'I cannot find this folder.' : 'I cannot find the place for the new folder.'};
  }
  if (!base) base = path.join(place, safePart(newName || 'What I found'));
  const items = [];
  const made = [];
  const lines = [];
  try {
    ensureDir(base, made);
    for (const f of files || []) {
      const from = isKnownFile(f.root, f.rel);
      if (!from || inside(base, from)) continue;
      const dir = path.join(base, ...(Array.isArray(f.parts) ? f.parts.map(safePart) : []));
      if (!inside(base, dir)) continue;
      ensureDir(dir, made);
      const to = freePath(dir, path.basename(from));
      if (mode === 'move') move(from, to);
      else copy(from, to);
      items.push({op: mode === 'move' ? 'move' : 'copy', from, to});
      lines.push(`${mode === 'move' ? 'moved ' : 'copied'}  ${from}  ->  ${to}`);
    }
  } catch (e) {
    const op = {id: newId(), type: 'collect', at: Date.now(), bases: [base], items, made};
    addOp(uid, op);
    note(uid, [base], lines);
    return {ok: false, error: String(e.message || e), id: op.id};
  }
  const op = {id: newId(), type: 'collect', at: Date.now(), bases: [base], items, made};
  addOp(uid, op);
  note(uid, [base], lines);
  known.add(base);
  return {ok: true, id: op.id, base, n: items.length};
};

// ---------- Media Library: move one file to another folder ----------
export const moveInLibrary = (uid, {root, rel, parts}) => {
  const lib = library(uid);
  if (!lib) return {ok: false, error: 'This project is not sorted yet.'};
  const e = lib.files.find((x) => x.root === root && x.rel === rel && !x.binned);
  const from = e && isKnownFile(root, rel);
  if (!from) return {ok: false, error: 'I cannot find this file any more.'};
  const ps = (parts || []).map(safePart);
  const dir = path.join(root, ...ps);
  if (!inside(root, dir)) return {ok: false, error: 'Not allowed.'};
  const made = [];
  try {
    ensureDir(dir, made);
    const to = freePath(dir, path.basename(from));
    move(from, to);
    const op = {id: newId(), type: 'move', at: Date.now(), bases: [root], items: [{op: 'move', from, to}], made, entry: {oldRel: rel, oldParts: e.parts}};
    e.rel = path.relative(root, to);
    e.parts = ps;
    op.entry.newRel = e.rel;
    addOp(uid, op);
    saveLib(uid, lib);
    note(uid, [root], [`moved   ${from}  ->  ${to}`]);
    return {ok: true, id: op.id, rel: e.rel};
  } catch (err) {
    return {ok: false, error: String(err.message || err)};
  }
};

// ---------- the Bin (macOS Trash) ----------
export const toBin = (uid, files) => {
  if (!projectDir(uid)) return {ok: false, error: 'This sorting project is not there any more.'};
  const lib = library(uid);
  const items = [];
  const lines = [];
  const bases = new Set();
  for (const f of files || []) {
    const from = isKnownFile(f.root, f.rel);
    if (!from) continue;
    const to = toTrash(from);
    items.push({op: 'bin', from, to, root: f.root, rel: f.rel});
    lines.push(`to Bin   ${from}  ->  ${to}`);
    bases.add(f.root);
    if (lib) {
      const e = lib.files.find((x) => x.root === f.root && x.rel === f.rel);
      if (e) e.binned = true;
    }
  }
  if (!items.length) return {ok: false, error: 'These files are not there any more.'};
  const op = {id: newId(), type: 'bin', at: Date.now(), bases: lib ? [...bases] : [], items};
  addOp(uid, op);
  if (lib) saveLib(uid, lib);
  note(uid, lib ? [...bases] : [], lines);
  return {ok: true, id: op.id, n: items.length};
};

// ---------- Undo one action, or Revert the whole sorting ----------
const undoOp = (uid, op, lib) => {
  const lines = [];
  for (const it of [...op.items].reverse()) {
    try {
      if (!fs.existsSync(it.to)) continue;
      if (it.op === 'copy') {
        const t = toTrash(it.to);
        lines.push(`copy to Bin  ${it.to}  ->  ${t}`);
      } else {
        fs.mkdirSync(path.dirname(it.from), {recursive: true});
        const back = fs.existsSync(it.from) ? freePath(path.dirname(it.from), path.basename(it.from)) : it.from;
        fs.renameSync(it.to, back);
        lines.push(`put back  ${it.to}  ->  ${back}`);
      }
    } catch {
      // left where it is; it shows in the log
    }
  }
  // the folders this app made, deepest first, once they are empty (only the hidden note left): to the Bin, never deleted
  for (const d of [...(op.made || [])].reverse()) {
    try {
      const left = fs.readdirSync(d).filter((n) => n !== '.DS_Store' && n !== MARK && n !== NOTE);
      if (!left.length) toTrash(d);
    } catch {
      // ignore
    }
  }
  op.undone = Date.now();
  if (lib) {
    if (op.type === 'move' && op.entry) {
      const e = lib.files.find((x) => x.rel === op.entry.newRel);
      if (e) {
        e.rel = op.entry.oldRel;
        e.parts = op.entry.oldParts;
      }
    }
    if (op.type === 'bring') lib.files = lib.files.filter((x) => !(x.brought && path.join(x.root, x.rel) === op.items[0].to));
    if (op.type === 'add') {
      const gone = new Set(op.items.map((it) => it.to));
      lib.files = lib.files.filter((x) => !gone.has(path.join(x.root, x.rel)));
    }
    if (op.type === 'bin')
      op.items.forEach((it) => {
        const e = lib.files.find((x) => x.root === it.root && x.rel === it.rel);
        if (e) e.binned = false;
      });
  }
  return {lines, bases: op.bases || []};
};

export const undo = (uid, id) => {
  const log = readLog(uid);
  const op = log.find((o) => o.id === id && !o.undone);
  if (!op) return {ok: false, error: 'There is nothing to undo.'};
  const lib = library(uid);
  const r = undoOp(uid, op, lib);
  writeJson(logFile(uid), log);
  if (op.type === 'sort') saveLib(uid, null);
  else if (lib) saveLib(uid, lib);
  note(uid, r.bases, r.lines);
  return {ok: true};
};

// Revert: undoes the sorting and everything done in the Media Library after it, newest first.
export const revert = (uid) => {
  const log = readLog(uid);
  const lib = library(uid);
  if (!lib) return {ok: false, error: 'This project is not sorted.'};
  const start = log.findIndex((o) => o.id === lib.op);
  if (start < 0) return {ok: false, error: 'I cannot find the sorting in the log.'};
  let lines = [];
  let bases = [];
  for (let k = log.length - 1; k >= start; k--) {
    if (log[k].undone) continue;
    const r = undoOp(uid, log[k], lib);
    lines = lines.concat(r.lines);
    bases = bases.concat(r.bases);
  }
  writeJson(logFile(uid), log);
  saveLib(uid, null);
  note(uid, bases, lines.concat(['REVERT done: every file is back where it was.']));
  return {ok: true};
};

// Hidden notes this app leaves in sorted top folders (step 3 counts them as "already sorted").
export const isSortedHere = (dir) => fs.existsSync(path.join(dir, MARK));
