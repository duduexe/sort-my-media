// Sort my Media: the link to Claude, the same way the Dudu editor does it:
// the server starts Claude Code on her Mac (`claude -p`) with her logged-in account, so no API key.
// One job at a time, a time limit, and a status the page asks for every second.
// Claude only gets reading tools here: it looks at clues and answers, it never moves or changes a file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawn, execFile} from 'node:child_process';

const HOME = os.homedir();
export const PATHS = `${HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH}`;
const ENV = {...process.env, PATH: PATHS};

// Speech and music tools: the new folder if it exists, otherwise the older one that is already on her Mac.
export const pythonForFacts = () => {
  for (const v of ['.sort-my-media-venv', '.sort-my-footage-venv']) {
    const p = path.join(HOME, v, 'bin', 'python');
    if (fs.existsSync(p)) return p;
  }
  return 'python3';
};

const exec = (cmd, args, timeout = 30000) =>
  new Promise((resolve) => execFile(cmd, args, {timeout, env: ENV, maxBuffer: 4e6}, (err, stdout, stderr) => resolve({err, stdout: String(stdout), stderr: String(stderr)})));

// What the app is connected to. "ping" really asks Claude for one word (once, then remembered).
let pingOk = null;
export const health = async ({ping = false} = {}) => {
  const [cl, ff, fp, sp, py] = await Promise.all([
    exec('claude', ['--version']),
    exec('ffmpeg', ['-version']),
    exec('ffprobe', ['-version']),
    exec('sips', ['--help']),
    exec(pythonForFacts(), ['-I', '-c', 'import faster_whisper, librosa; print("ok")'], 60000),
  ]);
  const model = fs.existsSync(path.join(HOME, '.cache', 'huggingface', 'hub', 'models--Systran--faster-whisper-tiny'));
  const out = {
    claude: !cl.err,
    claudeVersion: cl.err ? '' : cl.stdout.trim(),
    video: !ff.err,
    probe: !fp.err,
    mac: process.platform === 'darwin' && !sp.err,
    node: process.version,
    python: pythonForFacts(),
    speech: !py.err && py.stdout.includes('ok'),
    speechModel: model,
    signedIn: pingOk,
  };
  if (ping && out.claude && pingOk !== true) {
    const r = await askClaude('Reply with exactly the word: ready', {tools: '', minutes: 2});
    pingOk = r.ok && /ready/i.test(r.text);
    out.signedIn = pingOk;
    if (!pingOk) out.why = r.text;
  }
  return out;
};

// One run of `claude -p`. Resolves with {ok, text}. Never throws.
export const askClaude = (prompt, {tools = 'Read,Glob,Grep', minutes = 30, onStart} = {}) =>
  new Promise((resolve) => {
    const args = ['-p', prompt, '--output-format', 'json', '--permission-mode', 'default', '--disallowedTools', 'Edit,Write,NotebookEdit,Bash,WebFetch,WebSearch'];
    if (tools) args.push('--allowedTools', tools);
    let p;
    try {
      p = spawn('claude', args, {cwd: ROOT_DIR, stdio: ['ignore', 'pipe', 'pipe'], env: ENV});
    } catch {
      return resolve({ok: false, text: NOT_FOUND});
    }
    if (onStart) onStart(p);
    let out = '';
    let err = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      p.kill('SIGTERM');
    }, minutes * 60 * 1000);
    p.stdout.on('data', (b) => (out += b.toString()));
    p.stderr.on('data', (b) => (err = (err + b.toString()).slice(-4000)));
    p.on('error', () => {
      clearTimeout(timer);
      resolve({ok: false, text: NOT_FOUND});
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      let j = {};
      try {
        j = JSON.parse(out.slice(out.indexOf('{')));
      } catch {
        // not JSON: a failure, explained below
      }
      if (code === 0 && j.result && !j.is_error) return resolve({ok: true, text: String(j.result).trim()});
      const why = timedOut
        ? `Claude was still working after ${minutes} minutes, so I stopped it. Try again, or copy the request and paste it in the Claude app.`
        : /authenticate|login|OAuth|not logged/i.test(`${j.result ?? ''} ${err}`)
        ? 'Claude needs you to sign in once: open Terminal, type claude and press Enter, then type /login and follow the steps.'
        : code === null && !timedOut
        ? 'The request was stopped.'
        : `Claude could not finish (${String(j.result ?? err ?? '').trim().slice(0, 200) || 'no answer'}).`;
      resolve({ok: false, text: why});
    });
  });

const NOT_FOUND = 'I cannot find Claude on this Mac. Open Terminal, type claude and press Enter to check it is installed and signed in.';
let ROOT_DIR = process.cwd();
export const setRoot = (r) => (ROOT_DIR = r);

// Claude's answers are JSON, sometimes wrapped in a few words or a code block.
export const pickJson = (text, open = '{') => {
  const close = open === '{' ? '}' : ']';
  const a = text.indexOf(open);
  const b = text.lastIndexOf(close);
  if (a < 0 || b < a) return null;
  try {
    return JSON.parse(text.slice(a, b + 1));
  } catch {
    return null;
  }
};
