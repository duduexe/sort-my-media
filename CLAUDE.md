# Sort my Media: rules for Claude Code

Sort my Media is a Mac app that sorts photos, videos and sounds into clear folders. It runs on this Mac (http://localhost:5190) and asks Claude where each file should go through the `claude` command, with the person's own Claude account. No API key.

## Setting it up
If the person asks to set it up, or the app is not set up yet, follow SETUP.md step by step.

## Never break these
- Never delete a file. "Bin" means the macOS Trash, with Undo. Never empty the Trash.
- Never change what is inside a media file, and keep the original file names unless the person asks.
- Work only in the folders the person picks in the app. Nothing moves until they press the approve button in the app.
- Every move or copy is written to "where files went.txt" and the undo log, so Revert can put everything back.
- Ask before installing anything, and before anything that costs money. Never ask for or store a password or an API key.
- Use plain words: the person may not be a developer.

## Where things are
- `server.mjs`: the local server. `claude.mjs`: the link to Claude. `fileops.mjs`: moves, copies, undo. `app/index.html`: the page.
- `engine/`: the sorting engine and the clues for each file (`facts.py`).
- `projects/` and `.cache/` are made by the app on this Mac (sorting projects, small pictures). They are personal: never share them.
