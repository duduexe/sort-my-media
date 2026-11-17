// Sort my Media: sorting projects (BUILD_PLAN 7.1).
// One project = its folders, structure, choices, plan, catalogue (and later the log of where files went and undo).
// Each lives in ~/SortMyMedia/projects/<name>/. A project only holds small text files about her media,
// never the media itself, so removing a project never touches a picture, video or sound.
// "Remove" moves the project folder to the macOS Trash and can be undone. Nothing is ever deleted.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';

let DIR = '';
export const setProjectsRoot = (root) => {
  DIR = path.join(root, 'projects');
  fs.mkdirSync(DIR, {recursive: true});
};

const readJson = (file, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
};
// Written to a side file first, then swapped in, so a crash never leaves half a file.
const writeJson = (file, data) => {
  const tmp = `${file}.saving`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, file);
};

// Folder names: no / or : (the Mac does not allow them), short, and not starting with a dot.
export const cleanName = (n) =>
  String(n || '')
    .replace(/[\/:\\]/g, ' ')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '')
    .slice(0, 60);

const freeFolder = (name, except = '') => {
  const base = cleanName(name) || 'My sorting';
  let n = base;
  for (let k = 2; fs.existsSync(path.join(DIR, n)) && n !== except; k++) n = `${base} ${k}`;
  return n;
};

// All projects: folder name + its project.json
const all = () => {
  let entries = [];
  try {
    entries = fs.readdirSync(DIR, {withFileTypes: true});
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
    .map((e) => ({folder: e.name, data: readJson(path.join(DIR, e.name, 'project.json'))}))
    .filter((p) => p.data && p.data.uid);
};
const find = (uid) => all().find((p) => p.data.uid === uid) || null;
export const projectDir = (uid) => {
  const p = find(uid);
  return p ? path.join(DIR, p.folder) : '';
};

const fresh = (name, kind) => ({
  uid: crypto.randomBytes(6).toString('hex'),
  name,
  kind: kind === 'find' ? 'find' : 'sort',
  created: Date.now(),
  updated: Date.now(),
  step: 0,
  folders: [],
  structure: null,
  choices: {},
});

export const list = () =>
  all()
    .map(({folder, data}) => {
      const plan = readJson(path.join(DIR, folder, 'plan.json'), null);
      const cat = readJson(path.join(DIR, folder, 'catalogue.json'), null);
      const files = plan && Array.isArray(plan.files) ? plan.files : [];
      // a few pictures and videos for the card
      // after sorting, the files are at their new place (library.json)
      const lib = readJson(path.join(DIR, folder, 'library.json'), null);
      const now = {};
      if (lib && Array.isArray(lib.files)) lib.files.forEach((e) => e.from && !e.binned && (now[`${e.from.root}/${e.from.rel}`] = {root: e.root, rel: e.rel}));
      const thumbs = files.filter((f) => f.t === 'pic' || f.t === 'vid').filter((f) => !/\.svg$/i.test(f.rel)).filter((f) => !lib || now[`${f.root}/${f.rel}`]).slice(0, 4).map((f) => now[`${f.root}/${f.rel}`] || {root: f.root, rel: f.rel});
      return {
        uid: data.uid,
        name: data.name,
        kind: data.kind || 'sort',
        updated: data.updated || 0,
        folders: (data.folders || []).length,
        planned: files.length,
        catalogued: cat && cat.files ? Object.keys(cat.files).length : 0,
        analyzedAt: plan ? plan.at || 0 : 0,
        thumbs,
        roots: data.folders || [],
      };
    })
    .sort((a, b) => b.updated - a.updated);

export const create = (name, kind = 'sort') => {
  const folder = freeFolder(name || 'My sorting');
  const data = fresh(folder, kind);
  fs.mkdirSync(path.join(DIR, folder), {recursive: true});
  writeJson(path.join(DIR, folder, 'project.json'), data);
  return data;
};

export const get = (uid) => {
  const p = find(uid);
  if (!p) return null;
  const dir = path.join(DIR, p.folder);
  return {project: p.data, plan: readJson(path.join(dir, 'plan.json'), null)};
};

// The page sends what changed; only these fields are kept.
const FIELDS = ['step', 'folders', 'structure', 'choices', 'kind', 'moves', 'binned', 'dupDone', 'only'];
export const save = (uid, patch) => {
  const p = find(uid);
  if (!p) return null;
  const next = {...p.data};
  for (const k of FIELDS) if (patch && k in patch) next[k] = patch[k];
  if (Array.isArray(next.folders)) next.folders = next.folders.filter((f) => typeof f === 'string').slice(0, 8);
  next.updated = Date.now();
  writeJson(path.join(DIR, p.folder, 'project.json'), next);
  return next;
};

export const rename = (uid, name) => {
  const p = find(uid);
  if (!p) return null;
  const want = cleanName(name);
  if (!want) return p.data;
  const folder = want === p.folder ? p.folder : freeFolder(want, p.folder);
  if (folder !== p.folder) fs.renameSync(path.join(DIR, p.folder), path.join(DIR, folder));
  const next = {...p.data, name: folder, updated: Date.now()};
  writeJson(path.join(DIR, folder, 'project.json'), next);
  return next;
};

// A copy keeps the folders, structure, choices, plan and catalogue, but not the log of moves:
// those moves belong to the original project and its Revert.
export const duplicate = (uid) => {
  const p = find(uid);
  if (!p) return null;
  const folder = freeFolder(`${p.data.name} copy`);
  const from = path.join(DIR, p.folder);
  const to = path.join(DIR, folder);
  fs.mkdirSync(to, {recursive: true});
  for (const f of ['plan.json', 'catalogue.json']) if (fs.existsSync(path.join(from, f))) fs.copyFileSync(path.join(from, f), path.join(to, f));
  const data = {...p.data, uid: crypto.randomBytes(6).toString('hex'), name: folder, created: Date.now(), updated: Date.now()};
  writeJson(path.join(to, 'project.json'), data);
  return data;
};

// To the macOS Trash (never deleted). The page keeps the Trash path for Undo.
export const remove = (uid) => {
  const p = find(uid);
  if (!p) return null;
  const stamp = new Date().toISOString().replace(/\D/g, '').slice(2, 14);
  const trash = path.join(os.homedir(), '.Trash', `${p.folder} (Sort my Media project ${stamp})`);
  fs.renameSync(path.join(DIR, p.folder), trash);
  const log = readJson(path.join(DIR, '_removed.json'), []) || [];
  log.unshift({trash, name: p.data.name, at: Date.now()});
  writeJson(path.join(DIR, '_removed.json'), log.slice(0, 30));
  return {trash, name: p.data.name};
};
// "Recently removed": projects still in the Bin, so they can be put back after the Undo message is gone.
export const removed = () => (readJson(path.join(DIR, '_removed.json'), []) || []).filter((r) => fs.existsSync(path.join(r.trash, 'project.json'))).slice(0, 10);
export const restore = (trash) => {
  const t = path.resolve(String(trash || ''));
  if (path.dirname(t) !== path.join(os.homedir(), '.Trash') || !/\(Sort my Media project \d+\)$/.test(t)) return null;
  if (!fs.existsSync(path.join(t, 'project.json'))) return null;
  const data = readJson(path.join(t, 'project.json'));
  const folder = freeFolder(data && data.name ? data.name : 'My sorting');
  fs.renameSync(t, path.join(DIR, folder));
  writeJson(path.join(DIR, '_removed.json'), (readJson(path.join(DIR, '_removed.json'), []) || []).filter((r) => r.trash !== t));
  if (data && data.name !== folder) writeJson(path.join(DIR, folder, 'project.json'), {...data, name: folder});
  return {...data, name: folder};
};

// ---------- plan and catalogue ----------
export const savePlan = (uid, plan) => {
  const dir = projectDir(uid);
  if (!dir) return false;
  writeJson(path.join(dir, 'plan.json'), plan);
  return true;
};

// The catalogue (BUILD_PLAN 7.2): one entry per analyzed file, newest analysis wins.
// Kept per project, readable later by the search bar.
export const addToCatalogue = (uid, entries) => {
  const dir = projectDir(uid);
  if (!dir) return false;
  const file = path.join(dir, 'catalogue.json');
  const cat = readJson(file, null) || {about: 'What Claude saw and heard in each analyzed file of this sorting project.', files: {}};
  for (const e of entries) cat.files[e.path] = e;
  cat.updated = Date.now();
  writeJson(file, cat);
  return true;
};
export const catalogue = (uid) => {
  const dir = projectDir(uid);
  return dir ? readJson(path.join(dir, 'catalogue.json'), null) : null;
};

// Find something specific (BUILD_PLAN 7.3): the last search and its matches, kept with the project
export const saveFind = (uid, data) => {
  const dir = projectDir(uid);
  if (!dir) return false;
  writeJson(path.join(dir, 'find.json'), data);
  return true;
};
export const getFind = (uid) => {
  const dir = projectDir(uid);
  return dir ? readJson(path.join(dir, 'find.json'), null) : null;
};

// Media Library searches with Claude (newest first), kept with the project
export const saveSearches = (uid, list) => {
  const dir = projectDir(uid);
  if (!dir) return false;
  writeJson(path.join(dir, 'searches.json'), list);
  return true;
};
export const getSearches = (uid) => {
  const dir = projectDir(uid);
  return dir ? readJson(path.join(dir, 'searches.json'), []) : [];
};
