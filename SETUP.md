# Set up Sort my Media on a Mac

For Claude Code: follow these steps one by one for the person in front of you. They may not be a developer and may never have used the Terminal: use plain words, one step at a time, and wait for them when a step needs their hands. Check first, and only install what is missing. Ask them before every install and say in plain words what it is for. Never delete or change their files. Never ask for or store a password or an API key.

You may be running in the **Claude desktop app** (the Code part) or in the **Terminal**. Both work. In the desktop app you do the commands yourself; the person only has to say yes and, once, sign in.

## 1. Check what is there
Run each line and note what is missing:
- `sw_vers -productVersion` (macOS; this app needs a Mac for now)
- `xcode-select -p` (Apple's Command Line Tools; a new Mac often has none, see 3a)
- `~/.local/bin/claude --version || claude --version` (the Terminal version of Claude Code: Sort my Media sends its jobs to Claude through it)
- `node --version` (needs 18 or newer: runs the app)
- `ffmpeg -version` and `ffprobe -version` (video frames, small pictures, sound length)
- `~/.sort-my-media-venv/bin/python -c "import faster_whisper, librosa, numpy, scipy; print('ok')"` (listening to sounds and turning the first 30 seconds of speech into text)
- `sips --help` and `mdls -h` (built into every Mac)

Then tell them in two or three plain lines what is already there and what you will install, and why.

## 2. Claude for Sort my Media (do this first)
Sort my Media runs on its own after setup and sends its jobs to Claude with the `claude` command. The Claude desktop app keeps its own copy of Claude Code hidden inside itself, which other apps cannot use, so the Terminal version is needed too, even for people who only use the desktop app. It uses the same Claude account.

If `claude --version` failed in step 1:
1. Explain this in one or two sentences and ask: "May I install the Terminal version of Claude Code? It is Anthropic's official installer and takes about a minute."
2. On yes, run the official line yourself: `curl -fsSL https://claude.ai/install.sh | bash`
3. Check it: `~/.local/bin/claude --version` shows a version number. If not, run `~/.local/bin/claude doctor` and explain what it says in plain words.

Sign in (needed once, even if they are signed in to the desktop app). Check first whether it is already done:
- `~/.local/bin/claude -p "Reply with the word ok" --output-format json` (no `--max-turns`). If the answer contains "ok", it is signed in: go on to step 3.
- If it says not logged in (or asks to log in), the person signs in once. Signing in needs their hands, so open a Terminal window for them with Claude already started:
  `osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "~/.local/bin/claude"'`
  Then guide them, one line at a time:
  1. "A Terminal window opened. If it asks about a theme or trusting the folder, press Enter."
  2. "Choose to log in with your Claude account. A browser page opens: log in and press Authorize."
  3. "Back in the Terminal, when you see a box where you can type, type /exit and press Enter. You can close that window."
  4. Wait until they say it is done, then run the check line again.
- Their plan must include Claude Code (Pro, Max, Team or Enterprise; not the free plan). If the sign-in says the plan does not include it, tell them plainly and stop here.
- No API key is needed. What Sort my Media asks Claude counts on their own plan.

## 3. Install the rest (ask first each time)
Do these in this order. Each one can take a few minutes: say so before you start, so they do not think it is stuck.

### 3a. Apple's Command Line Tools (a new Mac often does not have them)
- Check: `xcode-select -p`. If it prints a folder, they are there: go to 3b.
- If not: they are Apple's free basic tools (Homebrew and Python need them). Ask, then run `xcode-select --install`. This opens an **Apple window**, it does not install anything by itself. Tell them: "A window from Apple opened (it may be behind other windows). Click Install, then Agree. It takes 5 to 15 minutes. Tell me when it says the software was installed."
- Then check again with `xcode-select -p` before going on. Do not run `python3` or `git` before this is done: on a new Mac they only open the same Apple window again.

### 3b. Homebrew (only if Node.js, ffmpeg or a Python 3.10 or newer are missing)
- Check: `/opt/homebrew/bin/brew --version || /usr/local/bin/brew --version`
- If missing, it needs the Mac password, which you cannot type for them. Open a Terminal window with the official line already running:
  `osascript -e 'tell application "Terminal" to activate' -e 'tell application "Terminal" to do script "/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\""'`
  Tell them: "Type your Mac password (nothing shows while you type) and press Enter. If it asks to press Enter or Return to continue, press it. Tell me when it says Installation successful." Then wait.
- **After Homebrew is installed, your own command window does not know where it is yet.** Start every following command with the Homebrew setup line, in the same command:
  `eval "$(/opt/homebrew/bin/brew shellenv 2>/dev/null || /usr/local/bin/brew shellenv)" && <command>`
  (Apple chip Macs use /opt/homebrew, older Intel Macs /usr/local.)
- So their own Terminal knows it too, ask, then add the line Homebrew suggests to `~/.zprofile` (only if it is not there yet): `grep -q "brew shellenv" ~/.zprofile 2>/dev/null || echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile` (on an Intel Mac, `/usr/local/bin/brew`). The Sort my Media icon finds the Homebrew tools by itself either way.

### 3c. The tools
- Node.js: `brew install node`
- ffmpeg (also gives ffprobe): `brew install ffmpeg`
- Python for the sound tools: they need **Python 3.10 or newer**. Apple's own Python is often 3.9, which is too old for some of them. Check `python3 --version`; if it is older than 3.10, install one with `brew install python@3.12` and use `$(brew --prefix)/bin/python3.12` below instead of `python3`.
- The sound tools, in their own folder so nothing else on the Mac changes:
  - `python3 -m venv ~/.sort-my-media-venv` (or the Python 3.12 from just above)
  - `~/.sort-my-media-venv/bin/pip install --upgrade pip faster-whisper librosa numpy scipy` (a few hundred MB, several minutes)
  - If this fails, the app still sorts, just without listening to sounds: tell them plainly and go on.
- The small speech model (about 75 MB, otherwise it downloads by itself the first time a sound is analysed):
  - `~/.sort-my-media-venv/bin/python -c "from faster_whisper import WhisperModel; WhisperModel('tiny', compute_type='int8')"`

## 4. The app icon
- In this folder: `zsh scripts/make_app.sh` puts "Sort my Media" in the Applications folder of their home folder (~/Applications) and on the Desktop.
- The icon opens the app in Google Chrome as its own window if Chrome is there, otherwise in their usual browser.
- Or start it by hand: `node server.mjs`, then open http://localhost:5190

## 5. Check
- Open the app for them: `open ~/"Applications/Sort my Media.app"` (or the Desktop icon).
- Ask them to press "Guide" at the top, then the "How to set up" tab. Every line should have a green tick. They press "Check the connection to Claude" once.
- Tell them in one plain sentence what you installed, that from now on they open Sort my Media with its icon (no Claude window needed), and that they can start with a new sorting project in My sortings.
