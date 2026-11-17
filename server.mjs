// Sort my Media: small local server. Plain Node, no extra packages.
// Looks at folders, makes small preview pictures and clues in .cache, and asks Claude where files should go.
// It never moves, renames or deletes anything in her folders.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {execFile} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {askClaude, health, pickJson, pythonForFacts, setRoot, PATHS} from './claude.mjs';
import * as P from './projects.mjs';
import * as F from './fileops.mjs';
import * as D from './dups.mjs';
import * as M from './meta.mjs';
import * as K from './memory.mjs';
import * as T from './tower.mjs';

const PORT = Number(process.env.SMM_PORT) || 5190; // SMM_PORT: only for tests of a second copy
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const CACHE = path.join(ROOT, '.cache');
fs.mkdirSync(CACHE, {recursive: true});
setRoot(ROOT);
P.setProjectsRoot(ROOT);

// Same file kinds as engine/sort-my-media/scripts/sorter.py
const PHOTO = new Set(['.jpg', '.jpeg', '.png', '.heic', '.webp', '.gif', '.tif', '.tiff', '.svg']);
const VIDEO = new Set(['.mp4', '.mov', '.m4v', '.avi', '.mkv', '.webm']);
const AUDIO = new Set(['.mp3', '.wav', '.m4a', '.aac', '.flac', '.ogg', '.aiff']);
const WORK = '_sorter_work';
const SORTED = new Set(['Pictures', 'Videos', 'Sounds', 'Other', 'Not sure']);
const SKIP_NAMES = new Set(['where files went.txt', 'plan.json']);
const MAX_FILES = 20000;

const kindOf = (file) => {
  const e = path.extname(file).toLowerCase();
  return PHOTO.has(e) ? 'pic' : VIDEO.has(e) ? 'vid' : AUDIO.has(e) ? 'snd' : 'oth';
};

// Folders the page has asked about; thumbnails are only made for files inside them.
const known = new Set();
// A folder saved in one of her sorting projects counts as picked by her.
const remember = (p) => {
  try {
    const r = fs.realpathSync(cleanPath(p));
    if (fs.statSync(r).isDirectory() && r !== '/' && r !== os.homedir()) known.add(r);
  } catch {
    // folder moved or not on this Mac right now
  }
};

// "~/Movies/My clips", quotes, backslashes from drag and drop, file:// links.
export const cleanPath = (raw) => {
  let p = String(raw || '').trim();
  p = p.replace(/^["'“‘]+|["'”’]+$/g, '');
  if (p.startsWith('file://')) p = decodeURIComponent(p.slice(7));
  p = p.replace(/\\(.)/g, '$1');
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  return p ? path.resolve(p) : '';
};

const scanFolder = (folder, so = {}) => {
  const sub = so.sub !== false;
  const hidden = !!so.hidden;
  const takeSorted = !!so.sorted;
  const files = [];
  let sorted = 0;
  let cloud = 0;
  let capped = false;
  const walk = (dir, top) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
    } catch {
      return;
    }
    for (const e of entries) {
      if (capped) return;
      if (e.name.startsWith('.')) {
        // iCloud placeholder: ".name.icloud" means the file is not on this Mac yet
        if (e.name.endsWith('.icloud')) cloud++;
        if (!hidden || e.name === '.DS_Store' || e.name === F.MARK || e.name.endsWith('.icloud') || e.isDirectory()) continue;
      }
      const full = path.join(dir, e.name);
      if (e.isDirectory()) {
        if (e.name === WORK || e.name === 'node_modules') continue;
        if (top && !takeSorted && (SORTED.has(e.name) || F.isSortedHere(full))) {
          sorted += countFiles(full);
          continue;
        }
        if (sub) walk(full, false);
      } else if (e.isFile()) {
        if (top && SKIP_NAMES.has(e.name)) continue;
        if (files.length >= MAX_FILES) {
          capped = true;
          return;
        }
        let st;
        try {
          st = fs.statSync(full);
        } catch {
          continue;
        }
        files.push({rel: path.relative(folder, full), t: kindOf(e.name), bytes: st.size, mtime: Math.round(st.mtimeMs), birth: Math.round(st.birthtimeMs)});
      }
    }
  };
  const countFiles = (dir) => {
    let n = 0;
    try {
      for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
        if (e.name.startsWith('.')) continue;
        if (e.isDirectory()) n += countFiles(path.join(dir, e.name));
        else if (e.isFile()) n++;
      }
    } catch {
      // unreadable folder
    }
    return n;
  };
  walk(folder, true);
  return {files, sorted, cloud, capped};
};

const run = (cmd, args, timeout = 30000) =>
  new Promise((resolve) => {
    execFile(cmd, args, {timeout, maxBuffer: 8e6, env: {...process.env, PATH: `/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`}}, (err, stdout, stderr) => resolve({err, stdout, stderr}));
  });

// Small preview pictures, made one at a time (up to 4) and kept in .cache, never inside her folders.
let busy = 0;
const waiting = [];
const slot = () =>
  new Promise((resolve) => {
    const go = () => {
      busy++;
      resolve(() => {
        busy--;
        const n = waiting.shift();
        if (n) n();
      });
    };
    busy < 4 ? go() : waiting.push(go);
  });

const thumbFor = async (file, size, mtime, big = false) => {
  const px = big ? 1400 : 260;
  const key = crypto.createHash('sha1').update(`${file}|${size}|${mtime}${big ? '|big' : ''}`).digest('hex');
  const out = path.join(CACHE, `${key}.jpg`);
  if (fs.existsSync(out)) return out;
  const free = await slot();
  try {
    const k = kindOf(file);
    if (k === 'pic') {
      await run('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', big ? '82' : '70', '-Z', String(px), file, '--out', out]);
    } else if (k === 'vid') {
      for (const ss of ['1', '0']) {
        await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', ss, '-i', file, '-frames:v', '1', '-vf', `scale=${px}:-2`, '-q:v', big ? '3' : '5', out]);
        if (fs.existsSync(out) && fs.statSync(out).size > 0) break;
      }
    }
  } finally {
    free();
  }
  return fs.existsSync(out) && fs.statSync(out).size > 0 ? out : '';
};

const insideKnown = (root, rel) => {
  try {
    const r = fs.realpathSync(root);
    if (![...known].some((k) => k === r)) return '';
    const full = fs.realpathSync(path.join(r, rel));
    return full.startsWith(r + path.sep) ? full : '';
  } catch {
    return '';
  }
};


// ---------- files of a folder after the "Advanced options" (BUILD_PLAN 7.10) ----------
const listFiles = async (real, rawOpts) => {
  const o = M.cleanOpts(rawOpts);
  const sc = scanFolder(real, {sub: o.sub, hidden: !o.skipHidden, sorted: !o.skipSorted});
  const files = sc.files.map((f) => ({root: real, ...f}));
  let recs = {};
  if (M.needsMeta(o)) recs = await M.metaFor(files.map((f) => ({path: path.join(real, f.rel), size: f.bytes, mtime: f.mtime, birth: f.birth})));
  const {used, left} = M.applyOpts(files, o, recs);
  return {...sc, used, left, all: files};
};

// clues for a list of files (facts.py), without a job: used for quality badges, sources and Find
const factsBatch = (items, dir, onProgress = () => {}) =>
  new Promise((resolve) => {
    fs.mkdirSync(dir, {recursive: true});
    const tag = crypto.randomBytes(4).toString('hex');
    const list = path.join(dir, `list_${tag}.json`);
    const dest = path.join(dir, `facts_${tag}.json`);
    fs.writeFileSync(list, JSON.stringify(items));
    const p = spawn(pythonForFacts(), ['-I', path.join(ROOT, 'engine', 'facts.py'), path.join(CACHE, 'facts'), list, dest], {cwd: ROOT, env: {...process.env, PATH: PATHS}});
    let buf = '';
    p.stdout.on('data', (b) => {
      buf += b.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        const m = l.match(/^PROGRESS (\d+) (\d+) (.*)$/);
        if (m) onProgress(Number(m[1]), Number(m[2]), m[3]);
      }
    });
    p.on('close', () => {
      try {
        resolve(JSON.parse(fs.readFileSync(dest, 'utf8')).map((f) => (f.look_at ? {...f, look_at: path.resolve(ROOT, f.look_at)} : f)));
      } catch {
        resolve([]);
      }
    });
    p.on('error', () => resolve([]));
  });

// licence words written inside a sound or video file (never invented)
const licenceTags = (file) =>
  new Promise((resolve) => {
    execFile('ffprobe', ['-v', 'error', '-show_entries', 'format_tags', '-of', 'json', file], {timeout: 20000, env: {...process.env, PATH: PATHS}}, (err, out) => {
      try {
        const tags = Object.fromEntries(Object.entries(JSON.parse(String(out)).format.tags || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
        const found = tags.license || tags.licence || tags.copyright || (tags.comment && /licen[cs]e|creative ?commons|cc[- ]by|public domain|royalty/i.test(tags.comment) ? tags.comment : '');
        resolve(found ? found.slice(0, 200) : '');
      } catch {
        resolve('');
      }
    });
  });
const siteOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
};

// quality and sources for files of a project (BUILD_PLAN 7.6, 7.7)
const extrasFor = async (files) => {
  const items = files.map((f, i) => ({i, path: path.join(f.root, f.rel), t: f.t, root: f.root, rel: f.rel})).filter((x) => fs.existsSync(x.path));
  const facts = await factsBatch(items, path.join(CACHE, 'extras'));
  const byI = new Map(facts.map((f) => [f.i, f]));
  const metas = await M.metaFor(items.map((x) => {
    const st = fs.statSync(x.path);
    return {path: x.path, size: st.size, mtime: Math.round(st.mtimeMs), birth: Math.round(st.birthtimeMs)};
  }));
  const out = {};
  for (const x of items) {
    const fx = byI.get(x.i) || {};
    const snd = fx.sound && typeof fx.sound === 'object' ? fx.sound : null;
    const sp = snd && snd.speech ? snd.speech : null;
    const m = metas[x.path] || {};
    let licence = m.copyright || '';
    if (!licence && (x.t === 'snd' || x.t === 'vid')) licence = await licenceTags(x.path);
    out[`${x.root}/${x.rel}`] = {
      q: {sharp: fx.quality ? fx.quality.sharp : null, bright: fx.quality ? fx.quality.bright : null, dark: fx.quality ? fx.quality.dark_all : false, secs: fx.seconds || m.secs || 0,
        silent: snd ? snd.silent_share : null, db: snd ? snd.mean_volume_db : null, nosound: fx.sound === 'no sound track',
        talk: sp ? sp.seconds_of_talking_in_first_30s : 0, sure: sp ? sp.sure_it_is_speech : 0, words: sp && sp.sure_it_is_speech >= 0.5 ? sp.text : ''},
      src: {from: (m.from || []).slice(0, 3), site: siteOf((m.from || [])[1] || (m.from || [])[0] || ''), licence, origin: M.originOf(path.basename(x.rel), m)},
    };
  }
  return out;
};

// ---------- jobs for Claude: one at a time, the page asks for the status every second ----------
const JOBS = path.join(CACHE, 'jobs');
const jobs = new Map();
const SORTS = new Map(); // Approve sorting runs per project, with a Cancel
const queue = [];
let current = null;
const BATCH = 200;

const readBody = (req) =>
  new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => {
      b += c;
      if (b.length > 2e7) req.destroy();
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(b || '{}'));
      } catch {
        resolve({});
      }
    });
  });

const publicJob = (j, full = false) => j && {known: j.known, list: full ? j.list : undefined, xr: full ? j.xr : undefined, phase: j.phase, xp: j.xp, picked: j.xr && j.xr.pick ? j.xr.pick.length : undefined, id: j.id, kind: j.kind, state: j.state, stage: j.stage, done: j.done, total: j.total, note: j.note, cur: j.stage === 'look' ? j.cur : undefined, error: j.error, result: j.state === 'done' ? j.result : undefined, prompt: j.state === 'failed' ? j.prompt : undefined};
const saveJob = (j) => {
  try {
    fs.mkdirSync(j.dir, {recursive: true});
    fs.writeFileSync(path.join(j.dir, 'status.json'), JSON.stringify(publicJob(j), null, 1));
  } catch {
    // status file is only a copy; the page reads the job from memory
  }
};
const newJob = (kind, input) => {
  const id = `${new Date().toISOString().replace(/\D/g, '').slice(2, 14)}_${kind}_${crypto.randomBytes(3).toString('hex')}`;
  const j = {id, kind, input, state: 'waiting', stage: 'waiting', done: 0, total: 0, note: '', dir: path.join(JOBS, id), kill: null};
  jobs.set(id, j);
  saveJob(j);
  queue.push(j);
  nextJob();
  return j;
};
const nextJob = async () => {
  if (current || !queue.length) return;
  current = queue.shift();
  const j = current;
  j.state = 'working';
  saveJob(j);
  // Control tower: a claim in the vault while Claude works, one Activity log line when it ends (tower.mjs).
  const claim = T.claimRun(j);
  const startedAt = Date.now();
  try {
    if (j.kind === 'suggest') await runSuggest(j);
    else if (j.kind === 'analyze') await runAnalyze(j);
    else if (j.kind === 'revise') await runRevise(j);
    else if (j.kind === 'find') await runFind(j);
    else if (j.kind === 'tags') await runTags(j);
    else if (j.kind === 'libsearch') await runLibSearch(j);
    else if (j.kind === 'organize') await runOrganize(j);
  } catch (e) {
    j.state = 'failed';
    j.error = `Something went wrong: ${String(e && e.message ? e.message : e).slice(0, 200)}`;
  }
  if (j.stopped) {
    j.state = 'stopped';
    j.error = 'Stopped.';
  }
  saveJob(j);
  T.closeRun(j, claim, (Date.now() - startedAt) / 60000);
  current = null;
  nextJob();
};
const fail = (j, why) => {
  j.state = 'failed';
  j.error = why;
};

// Category list as Claude sees it: "talk: Videos > On camera (with you) > Me talking".
const TYPE_NAMES = {pic: 'Pictures', vid: 'Videos', snd: 'Sounds', oth: 'Other'};
const catLines = (cats) =>
  cats
    .map((c) => `- ${c.id}: ${TYPE_NAMES[c.t] || c.t} > ${c.group ? `${c.group} > ` : ''}${c.name}${c.ns ? ' (when you cannot decide)' : ''}`)
    .join('\n');
const cleanCats = (cats) =>
  (Array.isArray(cats) ? cats : [])
    .filter((c) => c && typeof c.id === 'string' && TYPE_NAMES[c.t] && typeof c.name === 'string')
    .map((c) => ({id: c.id.slice(0, 60), t: c.t, name: c.name.slice(0, 80), group: typeof c.group === 'string' ? c.group.slice(0, 80) : '', ns: !!c.ns}));

// Step 1: "Ask Claude for a suggestion".
const runSuggest = async (j) => {
  const {text, cats, presets} = j.input;
  j.stage = 'claude';
  j.note = 'Claude is thinking about your folders';
  saveJob(j);
  const prompt = `The user uses the app "Sort my Media" to sort their photos, videos and sounds into folders. They describe their work like this:
"""${String(text).slice(0, 3000)}"""

Suggest the folder structure that fits them best.

Folder levels you can use (pick 1 to 3, in the order the folders nest):
- type: Media Type (Pictures, Videos, Sounds, Other)
- cat: Media Category (the categories below)
- topic: Topic or project (one folder per project)
- location: a place, for example Paris
- date: year and month
- origin: where it came from (Phone, Screen recording, Download)
- folder: the folder the file was found in

Ready-made use cases they can also pick:
${(presets || []).map((p) => `- ${p.name}: ${p.layers.join(' > ')}. ${p.desc}`).join('\n')}

Current categories (id: where it sits > name):
${catLines(cleanCats(cats))}

Answer with only this JSON, nothing else:
{"why": "one short plain sentence for the user about why this fits their work", "layers": ["type", "cat"], "ren": {"<category id>": "better name"}, "add": [{"t": "pic|vid|snd|oth", "name": "new folder"}], "flat": ["types that need no categories, for example snd"]}

Rules: rename only where it really helps their work, using their own words. At most 6 new folders, and only for things the current ones do not cover. Short plain names in sentence case. No long dashes. Never rename or add "Not sure" folders.`;
  j.prompt = prompt;
  const r = await askClaude(prompt, {tools: '', minutes: 5, onStart: (p) => (j.kill = () => p.kill('SIGTERM'))});
  if (!r.ok) return fail(j, r.text);
  const out = pickJson(r.text, '{');
  if (!out || !Array.isArray(out.layers)) return fail(j, 'Claude answered, but not in a way I can use. Try again.');
  j.result = out;
  j.state = 'done';
};

// Step 4: look at every file (clues), then Claude decides a folder for each, 200 files at a time.
const runFacts = (j, items, out) =>
  new Promise((resolve) => {
    const list = path.join(j.dir, `list_${out}.json`);
    const dest = path.join(j.dir, `facts_${out}.json`);
    fs.writeFileSync(list, JSON.stringify(items));
    const p = spawn(pythonForFacts(), ['-I', path.join(ROOT, 'engine', 'facts.py'), path.join(CACHE, 'facts'), list, dest], {cwd: ROOT, env: {...process.env, PATH: PATHS}});
    j.kill = () => p.kill('SIGTERM');
    const base = j.done;
    let buf = '';
    let tools = null;
    p.stdout.on('data', (b) => {
      buf += b.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const l of lines) {
        const m = l.match(/^PROGRESS (\d+) (\d+) (.*)$/);
        if (m) {
          j.done = base + Number(m[1]);
          j.note = m[3];
          const it = items[Number(m[1]) - 1];
          if (it) j.cur = {n: j.done, t: it.t, name: path.basename(it.path), root: it.root, rel: it.rel};
          saveJob(j);
        }
        if (l.startsWith('TOOLS ')) {
          try {
            tools = JSON.parse(l.slice(6));
          } catch {
            // ignore
          }
        }
      }
    });
    p.on('close', () => {
      try {
        resolve({facts: JSON.parse(fs.readFileSync(dest, 'utf8')), tools, file: dest});
      } catch {
        resolve({facts: null, tools});
      }
    });
    p.on('error', () => resolve({facts: null, tools}));
  });

const analyzePrompt = (factsFile, cats, layers, scope, need) => {
  const ns = cats.filter((c) => c.ns).map((c) => `${TYPE_NAMES[c.t]}: ${c.id}`).join(', ');
  // The example answer shows every field Claude must fill in for this structure.
  const ex = {i: 0, cat: 'shot', conf: 0.9, why: 'phone screenshot of a calendar app', summary: 'Phone screenshot of a calendar app showing the launch day in October', tags: ['calendar', 'phone', 'launch', 'october']};
  if (layers.includes('topic')) ex.topic = 'Launch calendar';
  if (layers.includes('location')) ex.place = '';
  if (scope === 'relevant') ex.keep = true;
  return `You are sorting media files for the user's app "Sort my Media". You only decide where each file should go. Do not move, rename or change any file.

First read the sorting rules in ${path.join(ROOT, 'engine', 'sort-my-media', 'SKILL.md')}. Use what it says about categories and about how to judge pictures, videos and sounds. Skip its steps about running scripts and asking questions: the clues are already collected for you.

The clues for every file are in ${factsFile} (a JSON list, one entry per file, "i" is its number). Read it. Then:
- "look_at" is a picture you must open with the Read tool: the picture itself (a smaller copy), or, for a video, 4 moments of it in one picture. Look at every one.
- "sound" has the loudness, the share of silence, the beat (tempo_bpm) and brightness. "speech" is the first 30 seconds turned into text, with "sure_it_is_speech" (0 to 1) and how many seconds of talking. A few words with a low "sure_it_is_speech" over music are usually lyrics or noise, not speech. Very short sounds are usually sound effects.
- "tags", "seconds", "pixels", "name", "folder", "text_start" and "svg_start" are more clues.
- "known" means you already looked at this file closely in an earlier project: its "summary", what was "said" and its "tags" are your own notes. Decide from them; it has no "look_at", so do not open it. You may keep the same summary and tags.
Never pretend you listened or watched more than these clues.

The folders to choose from (use the id on the left; a file can only go in a folder of its own kind: pictures in Pictures, videos in Videos and so on):
${catLines(cats)}

When you are not sure (confidence below 0.6), use the "Not sure" id of the file's kind (${ns}).
${layers.includes('topic') ? 'Their folders are organised by project, so every file MUST also get "topic": a short project or topic name (2 to 4 plain words, sentence case). Files that belong to the same video, guide or project get exactly the same name; look at names, dates, what is shown and what is said to group them. Use "Other projects" only when nothing fits.\n' : ''}${layers.includes('location') ? 'Also give "place": the city or place if the picture, the name or the tags make it clear, otherwise "".\n' : ''}${scope === 'relevant' ? `The user only needs files for this: "${String(need).slice(0, 500)}". Add "keep": true for files that fit, false for the others.\n` : ''}
Answer with only a JSON list, one object per file, in the same order as the clues, like this:
[${JSON.stringify(ex)}]
"why" is at most 10 plain words, saying which clues you used.
"summary" is one plain sentence (at most 25 words) saying what is shown and, if someone talks, what it is about. It is used later to find the file again by searching, so name the things, places, apps and topics you see or hear.
"tags" are 3 to 6 short lowercase tags (one or two words each) for people, places, objects, apps, topics and actions in the file, so the user can filter by them. Reuse the same tag words across files.`;
};


// Step 4 "Request changes to Claude": Claude reads the plan and her words, and answers only with what changes.
const runRevise = async (j) => {
  const {request, files, cats: rawCats, layers} = j.input;
  const cats = cleanCats(rawCats);
  fs.mkdirSync(j.dir, {recursive: true});
  const planFile = path.join(j.dir, 'plan_to_check.json');
  fs.writeFileSync(planFile, JSON.stringify((files || []).slice(0, 5000), null, 1));
  j.stage = 'claude';
  j.note = 'Claude is reading your request';
  saveJob(j);
  const prompt = `The user checked the sorting plan you made in their app "Sort my Media" and asks for changes:
"""${String(request).slice(0, 3000)}"""

The plan is in ${planFile}: one entry per file with its number "i", name, kind (pic, vid, snd, oth), the folder it goes to now ("goes_to"), its category id ("cat"), its project ("topic", if any), and what you saw and heard in it ("summary", "why"). Read it.

The folders you can use (id on the left; a file can only go in a folder of its own kind):
${catLines(cats)}
${(layers || []).includes('topic') ? 'Their folders are organised by project: you may also change "topic" (a short project name, sentence case).\n' : ''}
If their request needs a folder that does not exist yet, add it in "newFolders" with its kind, and use "new:<folder name>" as the cat of the files that go there.
List only the files that change. Never invent what is in a file: use the summary and why. If the request is not about where files go, say so in "reply" and change nothing.

Answer with only this JSON:
{"reply": "one or two plain sentences for the user about what you changed", "newFolders": [{"t": "pic", "name": "Logos"}], "changes": [{"i": 3, "cat": "gfx"}]}
No long dashes in the reply.`;
  j.prompt = prompt;
  const r = await askClaude(prompt, {tools: 'Read', minutes: 15, onStart: (p) => (j.kill = () => p.kill('SIGTERM'))});
  if (!r.ok) return fail(j, r.text);
  const out = pickJson(r.text, '{');
  if (!out || !Array.isArray(out.changes)) return fail(j, 'Claude answered, but not in a way I can use. Try again.');
  j.result = {reply: String(out.reply || '').slice(0, 600), newFolders: Array.isArray(out.newFolders) ? out.newFolders.slice(0, 12) : [], changes: out.changes.slice(0, 5000)};
  j.state = 'done';
};


const FONT = '/System/Library/Fonts/Supplemental/Arial Bold.ttf';
// small numbered pictures, 20 on one sheet, so Claude can glance at many files at once
const contactSheets = async (items, dir, onStep = () => {}) => {
  const sheets = [];
  const vis = items.filter((x) => (x.t === 'pic' && !/\.svg$/i.test(x.rel)) || x.t === 'vid');
  for (let s0 = 0; s0 < vis.length; s0 += 20) {
    onStep(s0 / Math.max(1, vis.length));
    const part = vis.slice(s0, s0 + 20);
    const sd = path.join(dir, `sheet_${s0 / 20}`);
    fs.mkdirSync(sd, {recursive: true});
    let k = 0;
    for (const x of part) {
      const full = path.join(x.root, x.rel);
      let th = '';
      try {
        const st = fs.statSync(full);
        th = await thumbFor(full, st.size, Math.round(st.mtimeMs));
      } catch {
        th = '';
      }
      const tile = path.join(sd, `t${String(k).padStart(3, '0')}.jpg`);
      const label = `drawtext=fontfile=${FONT}:text='${x.i}':x=6:y=6:fontsize=26:fontcolor=white:box=1:boxcolor=0x452785@0.9:boxborderw=5`;
      if (th) await run('ffmpeg', ['-v', 'error', '-y', '-i', th, '-vf', `scale=220:220:force_original_aspect_ratio=decrease,pad=240:240:(ow-iw)/2:(oh-ih)/2:color=white,${label}`, tile]);
      else await run('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'color=c=0xE6D5FA:s=240x240', '-frames:v', '1', '-vf', label, tile]);
      k++;
    }
    const out = path.join(dir, `sheet_${s0 / 20}.jpg`);
    await run('ffmpeg', ['-v', 'error', '-y', '-framerate', '1', '-i', path.join(sd, 't%03d.jpg'), '-vf', 'tile=5x4:padding=4:color=white', '-frames:v', '1', out]);
    if (fs.existsSync(out)) sheets.push(out);
  }
  return sheets;
};
const remembered = () => {
  // what earlier analyses and searches already know about files (all projects)
  const known = {};
  for (const p of P.list()) {
    const c = P.catalogue(p.uid);
    if (c && c.files) for (const [k, e] of Object.entries(c.files)) if (e.summary && !known[k]) known[k] = e;
  }
  return known;
};
const runFind = async (j) => {
  const {question, kinds, folders, opts} = j.input;
  const o = {...(opts || {}), kinds: kinds || (opts && opts.kinds)};
  j.stage = 'scan';
  j.phase = 'setup';
  j.note = 'Listing the files';
  saveJob(j);
  const all = [];
  for (const raw of folders || []) {
    let real;
    try {
      real = fs.realpathSync(cleanPath(raw));
    } catch {
      continue;
    }
    if (!known.has(real)) continue;
    const lf = await listFiles(real, o);
    lf.used.forEach((f) => all.push({root: real, rel: f.rel, t: f.t, bytes: f.bytes}));
  }
  if (!all.length) return fail(j, 'There are no files to search. Add a folder, or tick more kinds of files.');
  const mem = remembered();
  const metas = await M.metaFor(all.map((f) => {
    const st = fs.statSync(path.join(f.root, f.rel));
    return {path: path.join(f.root, f.rel), size: st.size, mtime: Math.round(st.mtimeMs), birth: Math.round(st.birthtimeMs)};
  }));
  const items = all.map((f, i) => {
    const full = path.join(f.root, f.rel);
    const m = metas[full] || {};
    const q = mem[full] ? null : K.recallQuick(full);
    const e = mem[full] || (q && {summary: q.summary, words: q.words});
    return {i, root: f.root, rel: f.rel, t: f.t, name: path.basename(f.rel), folder: path.dirname(f.rel) === '.' ? '' : path.dirname(f.rel), date: (m.date || '').slice(0, 10), mb: Math.round(f.bytes / 1e5) / 10, seconds: m.secs || undefined, already_known: e ? e.summary + (e.words ? ` Said: "${e.words.slice(0, 200)}"` : '') : undefined};
  });
  fs.mkdirSync(j.dir, {recursive: true});
  const listFile = path.join(j.dir, 'all_files.json');
  fs.writeFileSync(listFile, JSON.stringify(items.map(({root, rel, ...x}) => x), null, 1));
  j.total = items.length;
  j.stage = 'look';
  j.phase = 'xray';
  j.xp = 0;
  j.xr = {kinds: items.map((x) => (x.t || 'o')[0]).join('')};
  j.note = 'Making small pictures to glance at';
  saveJob(j);
  const sheets = items.length <= 1200 ? await contactSheets(items.filter((x) => !x.already_known), j.dir, (f) => (j.xp = f)) : [];
  j.xp = 1;
  // round 1: narrow down
  j.stage = 'claude';
  j.note = `Claude is glancing at ${items.length} files`;
  saveJob(j);
  const p1 = `The user is looking for something in their media with the app "Sort my Media":
"""${String(question).slice(0, 2000)}"""

All the files are listed in ${listFile} (number "i", name, folder, kind pic/vid/snd/oth, date, size in MB, length in seconds, and "already_known": what an earlier look found inside, when there is one). Read it.
${sheets.length ? `Small pictures of the pictures and videos (first moment), each with its number in the corner, are on these sheets: ${sheets.join(', ')}. Open them with the Read tool.` : ''}
Only narrow down for now: pick the files that could match, from their names, dates, folders, small pictures and what is already known. Keep it short: at most 60, the most likely first. Files with "already_known" that clearly match can be marked sure right away.
Answer with only JSON: {"candidates": [{"i": 3, "sure_already": false}]}`;
  j.prompt = p1;
  const r1 = await askClaude(p1, {tools: 'Read', minutes: 20, onStart: (p) => (j.kill = () => p.kill('SIGTERM'))});
  if (j.stopped) return;
  if (!r1.ok) return fail(j, r1.text);
  const c1 = pickJson(r1.text, '{');
  if (!c1 || !Array.isArray(c1.candidates)) return fail(j, 'Claude answered, but not in a way I can use. Try again.');
  const cand = c1.candidates.map((c) => items[c && c.i]).filter(Boolean).slice(0, 60);
  j.xr.pick = cand.map((x) => x.i);
  if (!cand.length) {
    j.result = {matches: [], looked: items.length, total: items.length, question};
    j.state = 'done';
    return;
  }
  // round 2: look closely only at the likely ones
  j.stage = 'look';
  j.phase = 'close';
  j.done = 0;
  j.total = cand.length;
  j.list = cand.map((x) => ({t: x.t, name: x.name, root: x.root, rel: x.rel, clue: 'likely match'}));
  j.note = 'Looking closely at the likely matches';
  saveJob(j);
  const fx = await factsBatch(cand.map((x, k) => ({i: k, path: path.join(x.root, x.rel), t: x.t})), j.dir, (d, n, name) => {
    j.done = d;
    j.note = name;
    j.cur = {t: cand[d - 1] && cand[d - 1].t, name, root: cand[d - 1] && cand[d - 1].root, rel: cand[d - 1] && cand[d - 1].rel};
    saveJob(j);
  });
  const closeFile = path.join(j.dir, 'close_look.json');
  fs.writeFileSync(closeFile, JSON.stringify(fx, null, 1));
  j.stage = 'claude';
  j.phase = 'decide';
  j.note = 'Claude is checking each likely match';
  saveJob(j);
  const p2 = `The user is looking for:
"""${String(question).slice(0, 2000)}"""

The likely files are in ${closeFile} (number "i", name, "look_at": a picture to open with Read, or 4 moments of a video in one picture; "sound" with "speech": the first 30 seconds as text). Look at each one closely.
For every file say if it matches. "sure": true only if you saw or heard it clearly. "why": at most 15 plain words saying what matched. "summary": one plain sentence about what is in the file (it is remembered for later searches).
Answer with only JSON: {"results": [{"i": 0, "match": true, "sure": true, "why": "she talks about Claude Projects at the start", "summary": "..."}]}`;
  j.prompt = p2;
  const r2 = await askClaude(p2, {tools: 'Read', minutes: 20, onStart: (p) => (j.kill = () => p.kill('SIGTERM'))});
  if (j.stopped) return;
  if (!r2.ok) return fail(j, r2.text);
  const c2 = pickJson(r2.text, '{');
  if (!c2 || !Array.isArray(c2.results)) return fail(j, 'Claude answered, but not in a way I can use. Try again.');
  const byK = new Map(c2.results.filter((x) => x && Number.isInteger(x.i)).map((x) => [x.i, x]));
  const matches = [];
  const entries = [];
  cand.forEach((x, k) => {
    const a = byK.get(k) || {};
    const f = fx.find((y) => y.i === k) || {};
    const sp = f.sound && typeof f.sound === 'object' ? f.sound.speech : null;
    entries.push({path: path.join(x.root, x.rel), root: x.root, rel: x.rel, name: x.name, kind: x.t, date: f.date || x.date, seconds: f.seconds || null, bytes: Math.round(x.mb * 1e6), summary: String(a.summary || '').slice(0, 240), words: sp && sp.sure_it_is_speech >= 0.5 ? sp.text : '', analyzed: new Date().toISOString(), looked_by: 'find'});
    if (a.match) matches.push({root: x.root, rel: x.rel, name: x.name, t: x.t, bytes: Math.round(x.mb * 1e6), date: f.date || x.date, seconds: f.seconds || null, sure: !!a.sure, why: String(a.why || '').slice(0, 160), summary: String(a.summary || '').slice(0, 240)});
  });
  if (j.input.project) {
    P.addToCatalogue(j.input.project, entries); // remembered for the next search
    K.remember(entries, 'search');
    P.saveFind(j.input.project, {question, at: Date.now(), looked: items.length, matches});
  }
  j.result = {matches, looked: items.length, close: cand.length, question};
  j.state = 'done';
  j.stage = 'done';
};


// ---------- Media Library: what each file is now (library place + plan row + catalogue) ----------
const libraryFiles = (uid) => {
  const r = P.get(uid);
  const lib = F.library(uid);
  if (!r || !lib || !r.plan) return [];
  const cat = P.catalogue(uid) || {files: {}};
  const rows = {};
  r.plan.files.forEach((f) => (rows[path.join(f.root, f.rel)] = f));
  return lib.files.filter((e) => !e.binned && e.from).map((e) => {
    const k0 = path.join(e.from.root, e.from.rel);
    const row = rows[k0] || {};
    const c = cat.files[k0] || {};
    return {k0, root: e.root, rel: e.rel, name: path.basename(e.rel), t: row.t || kindOf(e.rel), folder: (e.parts || []).join(' / '), date: String(row.date || c.date || '').slice(0, 10), seconds: row.seconds || c.seconds || undefined, summary: row.summary || c.summary || '', said: c.words || (row.x && row.x.q && row.x.q.words) || '', tags: row.tags || c.tags || [], project: row.topic || c.topic || ''};
  });
};

// Older plans have no tags yet: Claude adds them from what it already wrote about each file (text only, quick).
const runTags = async (j) => {
  const uid = j.input.project;
  const r = P.get(uid);
  if (!r || !r.plan) return fail(j, 'This project has no plan yet.');
  const cat = P.catalogue(uid) || {files: {}};
  const todo = r.plan.files.map((f, i) => ({i, f})).filter(({f}) => !Array.isArray(f.tags));
  if (!todo.length) {
    j.result = {tags: {}};
    j.state = 'done';
    return;
  }
  const out = {};
  for (let b = 0; b < todo.length; b += 300) {
    const part = todo.slice(b, b + 300);
    const list = part.map(({i, f}) => {
      const c = cat.files[path.join(f.root, f.rel)] || {};
      return {i, name: f.name, kind: f.t, summary: f.summary || c.summary || '', said: (c.words || '').slice(0, 300), why: f.why || ''};
    });
    fs.mkdirSync(j.dir, {recursive: true});
    const file = path.join(j.dir, `to_tag_${b}.json`);
    fs.writeFileSync(file, JSON.stringify(list, null, 1));
    j.stage = 'claude';
    j.note = 'Claude is adding tags to your files';
    saveJob(j);
    const prompt = `Read ${file}: files of the user's media library with what was seen and heard in each. Give every file 3 to 6 short lowercase tags (one or two words each) for people, places, objects, apps, topics and actions, so they can filter by them. Reuse the same tag words across files. Never invent what is not in the summary.
Answer with only JSON: {"tags": [{"i": 0, "tags": ["kitchen", "talking", "claude"]}]}`;
    j.prompt = prompt;
    const res = await askClaude(prompt, {tools: 'Read', minutes: 10, onStart: (p) => (j.kill = () => p.kill('SIGTERM'))});
    if (j.stopped) return;
    if (!res.ok) return fail(j, res.text);
    const got = pickJson(res.text, '{');
    if (!got || !Array.isArray(got.tags)) return fail(j, 'Claude answered, but not in a way I can use.');
    got.tags.forEach((x) => {
      if (x && Number.isInteger(x.i) && Array.isArray(x.tags)) out[x.i] = x.tags.map((t) => String(t).toLowerCase().trim().slice(0, 30)).filter(Boolean).slice(0, 6);
    });
  }
  const plan = P.get(uid).plan;
  const entries = [];
  Object.entries(out).forEach(([i, tags]) => {
    const f = plan.files[i];
    if (!f) return;
    f.tags = tags;
    const c = cat.files[path.join(f.root, f.rel)];
    if (c) entries.push({...c, tags});
  });
  P.savePlan(uid, plan);
  if (entries.length) P.addToCatalogue(uid, entries);
  j.result = {tags: out};
  j.state = 'done';
};

// "Run a search with Claude" inside the Media Library: reads what it already knows, looks again only if needed.
const runLibSearch = async (j) => {
  const {project: uid, question} = j.input;
  const files = libraryFiles(uid);
  if (!files.length) return fail(j, 'The Media Library of this project is empty.');
  fs.mkdirSync(j.dir, {recursive: true});
  const listFile = path.join(j.dir, 'library.json');
  fs.writeFileSync(listFile, JSON.stringify(files.map((f, i) => ({i, name: f.name, kind: f.t, folder: f.folder, date: f.date, seconds: f.seconds, summary: f.summary, said: f.said.slice(0, 400), tags: f.tags, project: f.project || undefined})), null, 1));
  j.total = files.length;
  j.stage = 'claude';
  j.note = `Claude is reading what it knows about ${files.length} files`;
  saveJob(j);
  const p1 = `The user searches their sorted Media Library:
"""${String(question).slice(0, 2000)}"""

Every file is listed in ${listFile}, with its folder, date, length, what was seen ("summary"), what was said ("said") and tags. Read it.
Give the files that match. Use only what is written there; when you are not sure from the text alone and a closer look at the picture or video would decide, put the file in "look_closer" (at most 20).
Answer with only JSON: {"results": [{"i": 3, "sure": true, "why": "she talks about Claude Projects at the start"}], "look_closer": [7, 12]}
"why" is at most 15 plain words.`;
  j.prompt = p1;
  const r1 = await askClaude(p1, {tools: 'Read', minutes: 15, onStart: (p) => (j.kill = () => p.kill('SIGTERM'))});
  if (j.stopped) return;
  if (!r1.ok) return fail(j, r1.text);
  const a1 = pickJson(r1.text, '{');
  if (!a1 || !Array.isArray(a1.results)) return fail(j, 'Claude answered, but not in a way I can use. Try again.');
  const found = new Map();
  a1.results.forEach((x) => x && files[x.i] && found.set(x.i, {sure: !!x.sure, why: String(x.why || '').slice(0, 160)}));
  const closer = (Array.isArray(a1.look_closer) ? a1.look_closer : []).filter((i) => files[i] && !(found.get(i) || {}).sure).slice(0, 20);
  if (closer.length) {
    j.stage = 'look';
    j.done = 0;
    j.total = closer.length;
    j.note = 'Looking closer at a few files';
    saveJob(j);
    const fx = await factsBatch(closer.map((i, k) => ({i: k, path: path.join(files[i].root, files[i].rel), t: files[i].t})), j.dir, (d, n, name) => {
      j.done = d;
      j.note = name;
      saveJob(j);
    });
    const closeFile = path.join(j.dir, 'close_look.json');
    fs.writeFileSync(closeFile, JSON.stringify(fx, null, 1));
    j.stage = 'claude';
    j.note = 'Claude is checking the closer look';
    saveJob(j);
    const p2 = `The user searches for:
"""${String(question).slice(0, 2000)}"""
Look closely at the files in ${closeFile} ("look_at": a picture to open with Read, or 4 moments of a video; "sound" and "speech": what is heard). For each, say if it matches.
Answer with only JSON: {"results": [{"i": 0, "match": true, "sure": true, "why": "..."}]}`;
    j.prompt = p2;
    const r2 = await askClaude(p2, {tools: 'Read', minutes: 15, onStart: (p) => (j.kill = () => p.kill('SIGTERM'))});
    if (j.stopped) return;
    const a2 = r2.ok ? pickJson(r2.text, '{') : null;
    if (a2 && Array.isArray(a2.results))
      a2.results.forEach((x) => {
        const i = closer[x && x.i];
        if (i === undefined) return;
        if (x.match) found.set(i, {sure: !!x.sure, why: String(x.why || '').slice(0, 160)});
        else found.delete(i);
      });
  }
  const results = [...found.entries()].map(([i, v]) => ({k0: files[i].k0, name: files[i].name, ...v})).sort((a, b) => b.sure - a.sure);
  const search = {id: crypto.randomBytes(4).toString('hex'), question: String(question).slice(0, 500), at: Date.now(), looked: files.length, results};
  P.saveSearches(uid, [search, ...(P.getSearches(uid) || [])].slice(0, 30));
  j.result = search;
  j.state = 'done';
};

// Find something specific: Claude puts the found files in folders, from a structure or from her own words.
// the subfolders of a folder she picked (4 levels, hidden ones skipped), with a few file names each
const folderTree = (top) => {
  const out = [];
  const walk = (dir, parts) => {
    if (out.length >= 400 || parts.length > 4) return;
    let ents;
    try {
      ents = fs.readdirSync(dir, {withFileTypes: true});
    } catch {
      return;
    }
    const names = ents.filter((e) => e.isFile() && !e.name.startsWith('.') && e.name !== 'where files went.txt').map((e) => e.name);
    if (parts.length) out.push({path: parts, files: names.length, examples: names.slice(0, 4)});
    for (const e of ents) if (e.isDirectory() && !e.name.startsWith('.') && e.name !== WORK) walk(path.join(dir, e.name), [...parts, e.name]);
  };
  walk(top, []);
  return out;
};
const runOrganize = async (j) => {
  const {matches, cats: rawCats, layers, instructions, existing} = j.input;
  const cats = cleanCats(rawCats);
  fs.mkdirSync(j.dir, {recursive: true});
  const file = path.join(j.dir, 'found.json');
  fs.writeFileSync(file, JSON.stringify((matches || []).slice(0, 2000), null, 1));
  if (existing) {
    let real;
    try {
      real = fs.realpathSync(existing);
    } catch {
      return fail(j, 'I cannot find this folder.');
    }
    const tree = folderTree(real);
    if (!tree.length) {
      j.result = {folders: {}, empty: true};
      j.state = 'done';
      return;
    }
    const treeFile = path.join(j.dir, 'folder.json');
    fs.writeFileSync(treeFile, JSON.stringify(tree, null, 1));
    j.stage = 'claude';
    j.note = 'Claude is finding the right place in your folder for each file';
    saveJob(j);
    const prompt = `The user found these files with their app "Sort my Media": ${file} (number "i", name, kind pic/vid/snd/oth, date, what is in it). Read it.
They want to put them into their existing folder "${path.basename(real)}". Its subfolders are listed in ${treeFile} (path as a list of folder names, how many files, a few example names). Read it.
For every file pick the existing subfolder where it belongs, the way that folder is already organized (by kind, by topic, by date, whatever it uses). Use only paths from the list, exactly as written. If no subfolder fits, use [] (the top of the folder).
Answer with only JSON: {"folders": [{"i": 0, "path": ["Videos", "Me talking"]}]}`;
    j.prompt = prompt;
    const r = await askClaude(prompt, {tools: 'Read', minutes: 10, onStart: (p) => (j.kill = () => p.kill('SIGTERM'))});
    if (j.stopped) return;
    if (!r.ok) return fail(j, r.text);
    const a = pickJson(r.text, '{');
    if (!a || !Array.isArray(a.folders)) return fail(j, 'Claude answered, but not in a way I can use. Try again.');
    const ok = new Set(tree.map((t) => JSON.stringify(t.path)));
    const out = {};
    a.folders.forEach((x) => {
      if (x && Number.isInteger(x.i) && Array.isArray(x.path)) out[x.i] = ok.has(JSON.stringify(x.path)) ? x.path : [];
    });
    j.result = {folders: out};
    j.state = 'done';
    return;
  }
  j.stage = 'claude';
  j.note = 'Claude is choosing a folder for each file';
  saveJob(j);
  const how = instructions
    ? `They want them organized like this, in their own words:\n"""${String(instructions).slice(0, 1500)}"""`
    : `Organize them by these levels, in this order: ${(layers || []).join(' > ')}. For "cat" use these folders (name after the ">" signs): \n${catLines(cats)}`;
  const prompt = `The user found these files with their app "Sort my Media": ${file} (number "i", name, kind pic/vid/snd/oth, date, what is in it). Read it.
${how}
Give every file its folder path as a list of folder names (short, plain, sentence case, no / or :). Files that fit nowhere go in "Not sure".
Answer with only JSON: {"folders": [{"i": 0, "path": ["Videos", "Me talking"]}]}`;
  j.prompt = prompt;
  const r = await askClaude(prompt, {tools: 'Read', minutes: 10, onStart: (p) => (j.kill = () => p.kill('SIGTERM'))});
  if (j.stopped) return;
  if (!r.ok) return fail(j, r.text);
  const a = pickJson(r.text, '{');
  if (!a || !Array.isArray(a.folders)) return fail(j, 'Claude answered, but not in a way I can use. Try again.');
  const out = {};
  a.folders.forEach((x) => {
    if (x && Number.isInteger(x.i) && Array.isArray(x.path)) out[x.i] = x.path.map((p) => String(p).slice(0, 60)).filter(Boolean).slice(0, 4);
  });
  j.result = {folders: out};
  j.state = 'done';
};

const runAnalyze = async (j) => {
  const {folders, cats: rawCats, layers, scope, need} = j.input;
  const cats = cleanCats(rawCats);
  if (!cats.length) return fail(j, 'The folder list from step 2 is missing. Go back to step 2 and try again.');
  // 1. the files, from the folders she added in step 3 only
  j.stage = 'scan';
  j.note = 'Listing your files';
  saveJob(j);
  const all = [];
  for (const raw of folders || []) {
    let real;
    try {
      real = fs.realpathSync(cleanPath(raw));
    } catch {
      continue;
    }
    if (!known.has(real)) continue;
    const lf = await listFiles(real, j.input.opts);
    for (const f of lf.used) all.push({root: real, rel: f.rel, t: f.t, bytes: f.bytes});
  }
  if (Array.isArray(j.input.only) && j.input.only.length) {
    const only = new Set(j.input.only);
    for (let k = all.length - 1; k >= 0; k--) if (!only.has(path.join(all[k].root, all[k].rel))) all.splice(k, 1);
  }
  if (!all.length) return fail(j, 'There are no files to look at. Add a folder in step 3, or check the Advanced options.');
  j.total = all.length;
  j.done = 0;
  j.xr = {kinds: all.map((f) => (f.t || 'o')[0]).join('')}; // the page draws one tile per file
  const lowest = Object.fromEntries(cats.filter((c) => c.ns).map((c) => [c.t, c.id]));
  const byId = Object.fromEntries(cats.map((c) => [c.id, c]));
  const files = [];
  const entries = [];
  let tools = null;
  // 2. per 200 files: clues first, then Claude
  for (let b = 0; b < all.length; b += BATCH) {
    if (j.stopped) return;
    const part = all.slice(b, b + BATCH);
    const items = part.map((f, k) => ({i: b + k, path: path.join(f.root, f.rel), t: f.t, root: f.root, rel: f.rel}));
    j.stage = 'look';
    j.phase = 'xray';
    saveJob(j);
    const facts = await runFacts(j, items, b / BATCH);
    if (j.stopped) return;
    if (!facts.facts) return fail(j, 'I could not read the clues from your files. Check that the files are on this Mac (not only in iCloud).');
    tools = facts.tools || tools;
    // look_at paths are made absolute so Claude can open them
    const fixed = facts.facts.map((f) => (f.look_at ? {...f, look_at: path.resolve(ROOT, f.look_at)} : f));
    // files Claude already looked at closely in another project: it decides from its own notes, without opening them again
    const knownOf = new Map();
    if (!(j.input.opts && j.input.opts.fresh)) {
      const pathOf = new Map(items.map((x) => [x.i, x.path]));
      fixed.forEach((f) => {
        const k = K.recall(pathOf.get(f.i));
        if (!k) return;
        knownOf.set(f.i, k);
        f.known = {summary: k.summary, said: (k.words || '').slice(0, 300), tags: k.tags || [], project: k.topic || ''};
        delete f.look_at;
      });
      j.known = (j.known || 0) + knownOf.size;
    }
    const factsOf = new Map(fixed.map((f) => [f.i, f]));
    // what was found, in a few words, for the scanner on the page while Claude decides
    const mmss = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, '0')}`;
    j.list = (j.list || []).concat(part.map((f, k) => {
      const fx = factsOf.get(b + k) || {};
      const snd = fx.sound && typeof fx.sound === 'object' ? fx.sound : null;
      const talk = snd && snd.speech && snd.speech.sure_it_is_speech >= 0.5 && snd.speech.seconds_of_talking_in_first_30s >= 1;
      const bits = [];
      if (fx.seconds) bits.push(mmss(fx.seconds));
      if (f.t === 'vid') bits.push(fx.sound === 'no sound track' ? 'no sound' : talk ? 'someone talks' : 'no talking');
      if (f.t === 'snd') bits.push(talk ? 'a voice' : snd && snd.tempo_bpm ? `beat ${snd.tempo_bpm}` : 'no voice');
      if (f.t === 'pic') bits.push(fx.pixels ? fx.pixels.replace('x', ' x ') : /\.svg$/i.test(f.rel) ? 'drawing' : 'picture');
      if (f.t === 'oth') bits.push(path.extname(f.rel).slice(1).toUpperCase() || 'file');
      return {root: f.root, rel: f.rel, t: f.t, name: path.basename(f.rel), clue: bits.join(' · ')};
    }));
    fs.writeFileSync(facts.file, JSON.stringify(fixed, null, 1));
    j.stage = 'claude';
    j.phase = 'decide';
    j.note = all.length > BATCH ? `Claude is deciding, part ${b / BATCH + 1} of ${Math.ceil(all.length / BATCH)}` : 'Claude is deciding where each file goes';
    saveJob(j);
    const prompt = analyzePrompt(facts.file, cats, layers || [], scope, need);
    j.prompt = prompt;
    const r = await askClaude(prompt, {tools: 'Read', minutes: 30, onStart: (p) => (j.kill = () => p.kill('SIGTERM'))});
    if (j.stopped) return;
    if (!r.ok) return fail(j, r.text);
    const ans = pickJson(r.text, '[');
    if (!Array.isArray(ans)) return fail(j, 'Claude answered, but not in a way I can use. Try again.');
    const got = new Map(ans.filter((a) => a && Number.isInteger(a.i)).map((a) => [a.i, a]));
    part.forEach((f, k) => {
      const i = b + k;
      const a = got.get(i) || {};
      const conf = typeof a.conf === 'number' ? a.conf : 0;
      let cat = byId[a.cat] && byId[a.cat].t === f.t ? a.cat : lowest[f.t];
      // low confidence goes to "Not sure", as the plan says
      if (conf < 0.6) cat = lowest[f.t];
      const row = {root: f.root, rel: f.rel, name: path.basename(f.rel), t: f.t, cat, conf: Math.round(conf * 100) / 100, why: String(a.why || (got.has(i) ? '' : 'Claude did not answer for this file')).slice(0, 140)};
      if (a.cat && a.cat !== cat) row.guess = a.cat;
      if (typeof a.topic === 'string') row.topic = a.topic.slice(0, 60);
      if (typeof a.place === 'string') row.place = a.place.slice(0, 60);
      if (typeof a.keep === 'boolean') row.keep = a.keep;
      if (typeof a.summary === 'string' && a.summary.trim()) row.summary = a.summary.slice(0, 240);
      else if (knownOf.has(i)) row.summary = knownOf.get(i).summary;
      if (!Array.isArray(a.tags) && knownOf.has(i)) row.tags = knownOf.get(i).tags || [];
      if (knownOf.has(i)) row.known = true;
      if (Array.isArray(a.tags)) row.tags = a.tags.map((t) => String(t).toLowerCase().trim().slice(0, 30)).filter(Boolean).slice(0, 6);
      const fx = factsOf.get(i) || {};
      row.date = fx.date || '';
      row.seconds = fx.seconds || null;
      row.bytes = f.bytes;
      files.push(row);
      // catalogue entry (BUILD_PLAN 7.2)
      const sp = fx.sound && typeof fx.sound === 'object' ? fx.sound.speech : null;
      const said = sp && sp.text && sp.sure_it_is_speech >= 0.5 && sp.seconds_of_talking_in_first_30s >= 1 ? sp.text : (knownOf.has(i) ? knownOf.get(i).words || '' : '');
      entries.push({
        path: path.join(f.root, f.rel), root: f.root, rel: f.rel, name: row.name, kind: f.t,
        date: fx.date || '', seconds: fx.seconds || null, bytes: f.bytes, pixels: fx.pixels || null,
        summary: row.summary || '', words: said, language: said ? sp.language : '',
        folder: cat, folderName: (byId[cat] || {}).name || '', tags: row.tags || [], topic: row.topic || '', place: row.place || '', sure: row.conf, analyzed: new Date().toISOString(),
      });
    });
  }
  j.result = {key: j.input.key || '', at: Date.now(), files, tools, known: j.known || 0};
  K.remember(entries, ((P.list().find((x) => x.uid === j.input.project) || {}).name) || '');
  fs.writeFileSync(path.join(j.dir, 'plan.json'), JSON.stringify(j.result, null, 1));
  if (j.input.project && j.input.add) {
    // Keep sorted: the new files join the plan that is already there
    const old = (P.get(j.input.project) || {}).plan;
    if (old && Array.isArray(old.files)) {
      const have = new Set(old.files.map((f) => `${f.root}/${f.rel}`));
      j.result = {...old, files: old.files.concat(files.filter((f) => !have.has(`${f.root}/${f.rel}`)))};
    }
    P.savePlan(j.input.project, j.result);
    P.addToCatalogue(j.input.project, entries);
  } else if (j.input.project) {
    P.savePlan(j.input.project, j.result);
    P.addToCatalogue(j.input.project, entries);
  }
  j.state = 'done';
  j.stage = 'done';
  j.note = '';
};

const send = (res, code, body, type = 'application/json; charset=utf-8') => {
  res.writeHead(code, {'Content-Type': type, 'Cache-Control': 'no-store'});
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
};

F.setup({projectDir: P.projectDir, known});
M.setup(CACHE);
K.setup(CACHE);
// the folders of her projects (and their sorted folders) are known again after a restart, so the small pictures on My sortings show
try {
  for (const p of P.list()) {
    const r = P.get(p.uid);
    ((r && r.project && r.project.folders) || []).forEach(remember);
    if (r && r.plan && Array.isArray(r.plan.files)) new Set(r.plan.files.map((f) => f.root)).forEach(remember);
    const lib = F.library(p.uid);
    if (lib) new Set(lib.files.map((e) => e.root)).forEach(remember);
  }
} catch {
  // only a convenience
}
// Claude's memory starts with what earlier projects already learned (files that were moved are found at their new place)
setTimeout(() => {
  try {
    for (const p of P.list()) {
      const c = P.catalogue(p.uid);
      if (!c || !c.files) continue;
      const lib = F.library(p.uid);
      const now = {};
      if (lib) lib.files.forEach((e) => e.from && !e.binned && (now[path.join(e.from.root, e.from.rel)] = path.join(e.root, e.rel)));
      K.remember(Object.entries(c.files).map(([k0, e]) => ({...e, path: now[k0] || k0})), p.name);
    }
  } catch {
    // only a speed-up
  }
}, 1500);
D.setup({cache: CACHE, thumb: (p, st) => thumbFor(p, st.size, Math.round(st.mtimeMs))});

const server = http.createServer(async (req, res) => {
  // Only this Mac and only this page: refuse other websites (same idea as the editor).
  const host = String(req.headers.host || '');
  if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host)) return send(res, 403, {ok: false, error: 'Not allowed'});
  const origin = req.headers.origin;
  if (origin && !/^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return send(res, 403, {ok: false, error: 'Not allowed'});
  const url = new URL(req.url, `http://${host}`);
  try {
    if (url.pathname === '/' || url.pathname === '/index.html') {
      return send(res, 200, fs.readFileSync(path.join(ROOT, 'app', 'index.html')), 'text/html; charset=utf-8');
    }
    if (url.pathname === '/favicon.ico') return send(res, 204, '', 'image/x-icon');
    if (url.pathname === '/api/scan') {
      const folder = cleanPath(url.searchParams.get('path'));
      if (!folder) return send(res, 200, {ok: false, error: 'Type or paste a folder path.'});
      if (!fs.existsSync(folder)) return send(res, 200, {ok: false, error: 'I cannot find this folder. Check the path.'});
      if (!fs.statSync(folder).isDirectory()) return send(res, 200, {ok: false, error: 'This is a file, not a folder.'});
      if (folder === '/' || folder === os.homedir()) return send(res, 200, {ok: false, error: 'This folder is too big. Pick a smaller folder inside it.'});
      try {
        fs.readdirSync(folder);
      } catch {
        return send(res, 200, {ok: false, error: 'The Mac does not let me open this folder.'});
      }
      const real = fs.realpathSync(folder);
      known.add(real);
      let opts = null;
      try {
        opts = JSON.parse(url.searchParams.get('opts') || 'null');
      } catch {
        opts = null;
      }
      const lf = await listFiles(real, opts);
      const counts = {pic: 0, vid: 0, snd: 0, oth: 0};
      lf.used.forEach((f) => counts[f.t]++);
      return send(res, 200, {ok: true, path: real, total: lf.used.length, all: lf.all.length, counts, sorted: lf.sorted, cloud: lf.cloud, capped: lf.capped, left: lf.left.length, leftList: lf.left.slice(0, 80)});
    }
    if (url.pathname === '/api/thumb') {
      const full = insideKnown(url.searchParams.get('root') || '', url.searchParams.get('rel') || '');
      if (!full) return send(res, 404, '', 'text/plain');
      const st = fs.statSync(full);
      const out = await thumbFor(full, st.size, Math.round(st.mtimeMs), url.searchParams.get('big') === '1');
      if (!out) return send(res, 404, '', 'text/plain');
      res.writeHead(200, {'Content-Type': 'image/jpeg', 'Cache-Control': 'max-age=3600'});
      return fs.createReadStream(out).pipe(res);
    }
    // ---------- sorting projects (BUILD_PLAN 7.1) ----------
    if (url.pathname === '/api/projects' && req.method === 'GET') {
      const l = P.list();
      l.forEach((p) => p.roots.forEach(remember));
      return send(res, 200, {ok: true, projects: l.map(({roots, ...rest}) => rest), removed: P.removed().map((r) => ({trash: r.trash, name: r.name, at: r.at}))});
    }
    if (url.pathname === '/api/projects' && req.method === 'POST') {
      const b = await readBody(req);
      if (b.action === 'new') return send(res, 200, {ok: true, project: P.create(b.name, b.kind)});
      if (b.action === 'rename') {
        const r = P.rename(b.uid, b.name);
        return send(res, 200, r ? {ok: true, project: r} : {ok: false, error: 'This sorting project is not there any more.'});
      }
      if (b.action === 'duplicate') {
        const r = P.duplicate(b.uid);
        return send(res, 200, r ? {ok: true, project: r} : {ok: false, error: 'This sorting project is not there any more.'});
      }
      if (b.action === 'remove') {
        const running = [...jobs.values()].find((x) => x.input && x.input.project === b.uid && (x.state === 'working' || x.state === 'waiting'));
        if (running) return send(res, 200, {ok: false, error: 'Claude is still analyzing this project. Stop it first.'});
        try {
          const r = P.remove(b.uid);
          return send(res, 200, r ? {ok: true, ...r} : {ok: false, error: 'This sorting project is not there any more.'});
        } catch {
          return send(res, 200, {ok: false, error: 'The Mac did not let me move this project to the Bin.'});
        }
      }
      if (b.action === 'restore') {
        try {
          const r = P.restore(b.trash);
          return send(res, 200, r ? {ok: true, project: r} : {ok: false, error: 'I cannot find this project in the Bin any more.'});
        } catch {
          return send(res, 200, {ok: false, error: 'The Mac did not let me take this project out of the Bin.'});
        }
      }
      return send(res, 200, {ok: false, error: 'Unknown request.'});
    }
    if (url.pathname === '/api/project' && req.method === 'GET') {
      const uid = url.searchParams.get('uid') || '';
      const r = P.get(uid);
      if (!r) return send(res, 200, {ok: false, error: 'This sorting project is not there any more.'});
      (r.project.folders || []).forEach(remember);
      if (r.plan && Array.isArray(r.plan.files)) {
        const c = P.catalogue(uid);
        const cf = (c && c.files) || {};
        r.plan.files.forEach((f) => {
          const e = cf[path.join(f.root, f.rel)];
          if (!e) return;
          if (!f.date) f.date = e.date;
          if (f.seconds == null) f.seconds = e.seconds;
          if (f.bytes == null) f.bytes = e.bytes;
          if (!f.summary) f.summary = e.summary;
        });
        // an empty 1980 date (downloads, zips): use the day the file was made
        const libNow = {};
        const lb = F.library(uid);
        if (lb) lb.files.forEach((e) => e.from && (libNow[path.join(e.from.root, e.from.rel)] = path.join(e.root, e.rel)));
        r.plan.files.forEach((f) => {
          if (f.date && String(f.date) >= '1991') return;
          const orig = path.join(f.root, f.rel);
          try {
            const st = fs.statSync(libNow[orig] || orig);
            const d = [st.birthtimeMs, st.mtimeMs].map((x) => new Date(x)).find((x) => x.getFullYear() > 1990);
            f.date = d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} 00:00` : 'none';
          } catch {
            // file not here right now
          }
        });
      }
      const running = [...jobs.values()].find((x) => x.kind === 'analyze' && x.input.project === uid && (x.state === 'working' || x.state === 'waiting'));
      const lib = F.library(uid);
      if (lib) new Set(lib.files.map((f) => f.root)).forEach((b) => known.add(b));
      return send(res, 200, {ok: true, ...r, library: lib, find: P.getFind(uid), searches: P.getSearches(uid) || [], job: running ? running.id : '', findJob: (([...jobs.values()].find((x) => x.kind === 'find' && x.input.project === uid && (x.state === 'working' || x.state === 'waiting'))) || {}).id || ''});
    }
    if (url.pathname === '/api/project/save' && req.method === 'POST') {
      const b = await readBody(req);
      const r = P.save(url.searchParams.get('uid') || '', b);
      return send(res, 200, r ? {ok: true, updated: r.updated} : {ok: false, error: 'This sorting project is not there any more.'});
    }
    if (url.pathname === '/api/catalogue') {
      const c = P.catalogue(url.searchParams.get('uid') || '');
      return send(res, 200, c ? {ok: true, ...c} : {ok: false, error: 'No catalogue yet.'});
    }
    // ---------- Advanced options counts, quality and sources, Find, search, Keep sorted ----------
    if (url.pathname === '/api/extras' && req.method === 'POST') {
      const b = await readBody(req);
      const files = (Array.isArray(b.files) ? b.files : []).filter((f) => f && insideKnown(f.root, f.rel)).slice(0, 5000);
      return send(res, 200, {ok: true, extras: await extrasFor(files)});
    }
    if (url.pathname === '/api/find' && req.method === 'POST') {
      const b = await readBody(req);
      if (!String(b.question || '').trim()) return send(res, 200, {ok: false, error: 'Write what you are looking for first.'});
      return send(res, 200, {ok: true, id: newJob('find', {project: b.project, question: b.question, kinds: b.kinds, folders: (b.folders || []).slice(0, 8), opts: b.opts}).id});
    }
    if (url.pathname === '/api/collect' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, F.collect(url.searchParams.get('uid') || '', {mode: b.mode === 'move' ? 'move' : 'copy', outDir: cleanPath(b.outDir || ''), newName: b.newName, into: b.into ? cleanPath(b.into) : '', files: b.files}));
    }
    if (url.pathname === '/api/reveal' && req.method === 'POST') {
      const b = await readBody(req);
      const full = insideKnown(b.root || '', b.rel || '');
      if (!full) return send(res, 200, {ok: false, error: 'I cannot find this file any more.'});
      await run('open', ['-R', full]);
      return send(res, 200, {ok: true});
    }
    if (url.pathname === '/api/tags' && req.method === 'POST') {
      const b = await readBody(req);
      const busy = [...jobs.values()].find((x) => x.kind === 'tags' && x.input.project === b.project && (x.state === 'working' || x.state === 'waiting'));
      return send(res, 200, {ok: true, id: busy ? busy.id : newJob('tags', {project: b.project}).id});
    }
    if (url.pathname === '/api/libsearch' && req.method === 'POST') {
      const b = await readBody(req);
      if (!String(b.question || '').trim()) return send(res, 200, {ok: false, error: 'Describe what you are looking for first.'});
      return send(res, 200, {ok: true, id: newJob('libsearch', {project: b.project, question: b.question}).id});
    }
    if (url.pathname === '/api/searches' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, {ok: P.saveSearches(url.searchParams.get('uid') || '', Array.isArray(b.searches) ? b.searches.slice(0, 30) : [])});
    }
    if (url.pathname === '/api/organize' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, {ok: true, id: newJob('organize', {matches: b.matches, cats: b.cats, layers: b.layers, instructions: b.instructions, existing: b.existing ? cleanPath(b.existing) : ''}).id});
    }
    if (url.pathname === '/api/pending') {
      // Keep sorted (BUILD_PLAN 7.5): files that came into her folders after the sorting
      const uid = url.searchParams.get('uid') || '';
      const r = P.get(uid);
      const lib = F.library(uid);
      if (!r || !lib) return send(res, 200, {ok: true, files: []});
      const have = new Set(lib.files.map((e) => e.from && path.join(e.from.root, e.from.rel)));
      lib.files.forEach((e) => have.add(path.join(e.root, e.rel)));
      const binned = r.project.binned || {};
      const files = [];
      for (const raw of r.project.folders || []) {
        let real;
        try {
          real = fs.realpathSync(cleanPath(raw));
        } catch {
          continue;
        }
        remember(real);
        const lf = await listFiles(real, (r.project.choices || {}).opts);
        lf.used.forEach((f) => {
          const full = path.join(real, f.rel);
          if (!have.has(full) && !binned[full] && !(lib.base && full.startsWith(lib.base + path.sep))) files.push({root: real, rel: f.rel, t: f.t, bytes: f.bytes});
        });
      }
      return send(res, 200, {ok: true, files});
    }
    // ---------- validate sorting, Media Library, duplicates ----------
    if (url.pathname === '/api/approve' && req.method === 'POST') {
      const b = await readBody(req);
      const uid = url.searchParams.get('uid') || '';
      const cur = SORTS.get(uid);
      if (cur && cur.running) return send(res, 200, {ok: false, error: 'This project is already being sorted.'});
      const mode = ['inplace', 'copy', 'merge'].includes(b.mode) ? b.mode : 'inplace';
      const files = Array.isArray(b.files) ? b.files : [];
      const st = {running: true, done: 0, total: files.length, stop: false, result: null};
      SORTS.set(uid, st);
      F.approve(uid, {mode, newName: b.newName, outDir: cleanPath(b.outDir || ''), files, add: !!b.add}, {stop: () => st.stop, progress: (d, n) => ((st.done = d), (st.total = n))})
        .then((r) => ((st.result = r), (st.running = false)))
        .catch((e) => ((st.result = {ok: false, error: String(e.message || e)}), (st.running = false)));
      return send(res, 200, {ok: true, started: true});
    }
    if (url.pathname === '/api/approve/status') {
      const st = SORTS.get(url.searchParams.get('uid') || '');
      if (!st) return send(res, 200, {ok: false, error: 'No sorting is running.'});
      return send(res, 200, {ok: true, running: st.running, done: st.done, total: st.total, result: st.running ? null : st.result});
    }
    if (url.pathname === '/api/approve/cancel' && req.method === 'POST') {
      const st = SORTS.get(url.searchParams.get('uid') || '');
      if (st && st.running) st.stop = true;
      return send(res, 200, {ok: true});
    }
    if (url.pathname === '/api/libmove' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, F.moveInLibrary(url.searchParams.get('uid') || '', b));
    }
    if (url.pathname === '/api/bin' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, F.toBin(url.searchParams.get('uid') || '', Array.isArray(b.files) ? b.files : []));
    }
    if (url.pathname === '/api/undo' && req.method === 'POST') {
      const b = await readBody(req);
      return send(res, 200, F.undo(url.searchParams.get('uid') || '', String(b.id || '')));
    }
    if (url.pathname === '/api/revert' && req.method === 'POST') {
      return send(res, 200, F.revert(url.searchParams.get('uid') || ''));
    }
    if (url.pathname === '/api/dups') {
      const uid = url.searchParams.get('uid') || '';
      const r = P.get(uid);
      if (!r) return send(res, 200, {ok: false, error: 'This sorting project is not there any more.'});
      const lib = F.library(uid);
      let files = [];
      if (lib) {
        files = lib.files.filter((f) => !f.binned).map((f) => {
          let bytes = 0;
          try {
            bytes = fs.statSync(path.join(f.root, f.rel)).size;
          } catch {
            return null;
          }
          return {root: f.root, rel: f.rel, t: kindOf(f.rel), bytes, from: f.from};
        }).filter(Boolean);
      } else {
        for (const raw of r.project.folders || []) {
          let real;
          try {
            real = fs.realpathSync(cleanPath(raw));
          } catch {
            continue;
          }
          remember(real);
          for (const f of (await listFiles(real, (r.project.choices || {}).opts)).used) files.push({root: real, rel: f.rel, t: f.t, bytes: f.bytes});
        }
      }
      const groups = await D.findDups(files);
      return send(res, 200, {ok: true, checked: files.length, groups: groups.map((g) => ({...g, items: g.items.map((f) => ({root: f.root, rel: f.rel, name: path.basename(f.rel), t: f.t, bytes: f.bytes, from: f.from}))}))});
    }
    if (url.pathname === '/api/revise' && req.method === 'POST') {
      const b = await readBody(req);
      if (!String(b.request || '').trim()) return send(res, 200, {ok: false, error: 'Write what you want Claude to change first.'});
      return send(res, 200, {ok: true, id: newJob('revise', {project: b.project, request: b.request, files: b.files, cats: b.cats, layers: b.layers}).id});
    }
    if (url.pathname === '/api/project/plan' && req.method === 'POST') {
      const b = await readBody(req);
      if (!b || !Array.isArray(b.files)) return send(res, 200, {ok: false, error: 'No plan.'});
      return send(res, 200, {ok: P.savePlan(url.searchParams.get('uid') || '', b)});
    }
    if (url.pathname === '/api/health') {
      return send(res, 200, {ok: true, ...(await health({ping: url.searchParams.get('ping') === '1'}))});
    }
    if (url.pathname === '/api/suggest' && req.method === 'POST') {
      const b = await readBody(req);
      if (!String(b.text || '').trim()) return send(res, 200, {ok: false, error: 'Write a few words about your work first.'});
      return send(res, 200, {ok: true, id: newJob('suggest', {text: b.text, cats: b.cats, presets: (b.presets || []).slice(0, 12)}).id});
    }
    if (url.pathname === '/api/analyze' && req.method === 'POST') {
      const b = await readBody(req);
      const project = typeof b.project === 'string' ? b.project : '';
      if (project) {
        const busy = [...jobs.values()].find((x) => x.kind === 'analyze' && x.input.project === project && (x.state === 'working' || x.state === 'waiting'));
        if (busy) return send(res, 200, {ok: true, id: busy.id});
      }
      return send(res, 200, {ok: true, id: newJob('analyze', {project, key: String(b.key || '').slice(0, 20000), folders: (b.folders || []).slice(0, 8), cats: b.cats, layers: b.layers, scope: b.scope, need: b.need, opts: b.opts, only: Array.isArray(b.only) ? b.only.slice(0, 20000) : null, add: !!b.add}).id});
    }
    if (url.pathname === '/api/job') {
      const j = jobs.get(url.searchParams.get('id') || '');
      if (!j) return send(res, 200, {ok: false, error: 'This request is not known any more. Start it again.'});
      const ahead = j.state === 'waiting' ? queue.indexOf(j) + (current ? 1 : 0) : 0;
      return send(res, 200, {ok: true, ...publicJob(j, url.searchParams.get('full') === '1'), ahead});
    }
    if (url.pathname === '/api/job/stop' && req.method === 'POST') {
      const j = jobs.get(url.searchParams.get('id') || '');
      if (j && (j.state === 'working' || j.state === 'waiting')) {
        j.stopped = true;
        const q = queue.indexOf(j);
        if (q > -1) {
          queue.splice(q, 1);
          j.state = 'stopped';
          saveJob(j);
        }
        if (j.kill) j.kill();
      }
      return send(res, 200, {ok: true});
    }
    // Step 3: where the new sorted folder goes (only when she picks "new folder").
    if (url.pathname === '/api/where') {
      const place = cleanPath(url.searchParams.get('path'));
      const name = String(url.searchParams.get('name') || '').trim();
      if (!place) return send(res, 200, {ok: false, error: 'Choose where the new folder goes.'});
      if (!fs.existsSync(place) || !fs.statSync(place).isDirectory()) return send(res, 200, {ok: false, error: 'I cannot find this place. Check the path.'});
      try {
        fs.accessSync(place, fs.constants.W_OK);
      } catch {
        return send(res, 200, {ok: false, error: 'The Mac does not let me put a folder here. Pick another place.'});
      }
      const real = fs.realpathSync(place);
      if (/[\/:]/.test(name)) return send(res, 200, {ok: false, error: 'The folder name cannot contain / or :'});
      const target = name ? path.join(real, name) : real;
      const inside = [...known].some((k) => target === k || target.startsWith(k + path.sep));
      return send(res, 200, {ok: true, path: real, target, exists: !!name && fs.existsSync(target), inside});
    }
    if (url.pathname === '/api/file') {
      const full = insideKnown(url.searchParams.get('root') || '', url.searchParams.get('rel') || '');
      if (!full) return send(res, 404, '', 'text/plain');
      const size = fs.statSync(full).size;
      const TYPES_OUT = {'.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.aac': 'audio/aac', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.aiff': 'audio/aiff', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml'};
      const type = TYPES_OUT[path.extname(full).toLowerCase()] || 'application/octet-stream';
      const m = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range || ''));
      if (m) {
        let a = m[1] === '' ? size - Number(m[2]) : Number(m[1]);
        let b = m[1] === '' || m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
        if (!(a >= 0 && a <= b)) {
          res.writeHead(416, {'Content-Range': `bytes */${size}`});
          return res.end();
        }
        res.writeHead(206, {'Content-Type': type, 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${size}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'});
        return fs.createReadStream(full, {start: a, end: b}).pipe(res);
      }
      res.writeHead(200, {'Content-Type': type, 'Content-Length': size, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store'});
      return fs.createReadStream(full).pipe(res);
    }
    if (url.pathname === '/api/choose' && req.method === 'POST') {
      const ask = {out: 'Choose where the new folder goes', into: 'Choose the folder for the files'}[url.searchParams.get('for')] || 'Choose a folder';
      const r = await run('osascript', ['-e', `POSIX path of (choose folder with prompt "${ask}")`], 300000);
      if (r.err) return send(res, 200, {ok: false, cancelled: true});
      return send(res, 200, {ok: true, path: String(r.stdout).trim().replace(/\/$/, '')});
    }
    send(res, 404, {ok: false, error: 'Not found'});
  } catch (e) {
    send(res, 500, {ok: false, error: String(e && e.message ? e.message : e)});
  }
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.log(`Sort my Media is already open: http://localhost:${PORT}`);
  else console.log(String(e));
  process.exit(e.code === 'EADDRINUSE' ? 0 : 1);
});
server.listen(PORT, '127.0.0.1', () => console.log(`Sort my Media is running: http://localhost:${PORT}`));
