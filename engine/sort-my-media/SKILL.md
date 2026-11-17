---
name: sort-my-media
description: Sort a folder of photos, screenshots, videos and audio by moving each file into folders by what it is (pictures, videos, sounds, other) and sub-categories. Use when the user says "sort my media", "sort my files", "sort my footage", "organise my camera roll" or similar.
---

# Sort my media

Safe rules (never break these):
- Work only inside the folder the user names (default: a folder called "Sort me").
- Never delete a file. Never change what is inside a file. By default only MOVE files and keep their file names unchanged. Rename only if the user asks for it.
- Show the plan first and wait for the user to say "go".
- Every move is logged in "where files went.txt" and in _sorter_work, so "undo" can put everything back. Undo leaves the new folders empty; it does not delete them.

The script `scripts/sorter.py` inside this skill's folder (Python 3, no extra packages) does the file work. Always call it by its full path, for example `python3 ~/.claude/skills/sort-my-media/scripts/sorter.py` in Claude Code, or the matching path of this skill's folder in the Claude app.

The script writes a working folder `_sorter_work` inside the sorted folder (still frames, a temporary sound file, the move log needed for undo). Tell the user it can be deleted once they no longer need undo.

## Speech and music tools (set up once, ask first)
Speech detection and music analysis need two free Python packages. At the start of every sort (Step 1), ask whether the user wants the sound analysed. If yes and the tools are not installed yet, install them right away, before scanning in a private environment so the computer's own Python is not touched:
```
python3 -m venv ~/.sort-my-media-venv
~/.sort-my-media-venv/bin/pip install faster-whisper "av<16" librosa
```
After that, run the script with `~/.sort-my-media-venv/bin/python` instead of `python3`. The first speech run downloads a small speech model (about 75 MB). If the install fails (for example blocked websites), continue without speech and say so.

## Steps

1. Ask which folder to sort. Then ask in one short question what the user uses these files for (for example content creation, family trips, work projects), and suggest sub-folders that fit. Top-level folders are always: Pictures, Videos, Sounds, Other, Not sure. Sub-folders inside the first four come from the user's use case. Always classify into sub-categories, not only the top folders. Each of Pictures, Videos, Sounds and Other has its own "Not sure" sub-folder; the top-level "Not sure" is for files you cannot even type. Default sub-categories (the user may rename, add or drop any): Pictures (Photos of people, Photos of places, Food and products, Screenshots, Graphics and design); Videos (Talking head, Interview or conversation, Screen recording, B-roll landscape (basically no people), B-roll people and activities (includes behind the scenes), B-roll food and products, Animation and graphics); Sounds (Speech and voice notes, Music, Sound effects, Ambience); Other (Documents, Project files). Show the folder list and let the user change it before starting.
   Also ask, in the same message: "Do you want me to analyse the sound too? It helps tell talking heads, interviews and b-roll apart, and voice notes from music. It needs a free speech tool (about 30 seconds to install, plus a 75 MB download the first time)." If the user says yes, first check whether `~/.sort-my-media-venv/bin/python` exists and can import faster_whisper; if not, install it as described in "Speech and music tools", then continue. If the user says no, skip `speech` and decide from the frames, loudness and tags only, and say so in the report. Also check for `ffmpeg` at this point (needed for videos and sounds): if it is missing, say what you would install and ask before installing.
2. Run `python3 <skill folder>/scripts/sorter.py scan "<folder>" 0 200`. It lists up to 200 files that are not sorted yet (type, size, length, size in pixels, tags in audio files). Big folders: work in chunks of 200 (offset 0, then after applying the plan run the same command again, because sorted files drop out of the list, so a stopped run can just be restarted). Videos and audio need ffmpeg. If `ffmpeg` is missing, tell the user what you would install, ask first, and continue with names only if they say no.
3. Look at the files:
   - Photos and screenshots: open the image. The pixel size helps (phone screenshot shapes).
   - Videos: run `python3 <skill folder>/scripts/sorter.py frames "<file>" 4`, then look at the frames. Run `python3 <skill folder>/scripts/sorter.py audio "<file>"` to see whether there is sound (has_audio_stream, loudness). Only if the user wanted sound analysis and the clip has sound (has_audio_stream true), run `speech` on it to get the first 30 seconds as text. Speech to camera with one person is a talking head, several people is an interview or conversation, no speech means b-roll. If the speech tool is not installed, see "Speech and music tools" above; otherwise decide from the frames alone.
   - Audio: run `python3 <skill folder>/scripts/sorter.py audio "<file>"` (loudness, silence share, and tempo and brightness if librosa is installed). Combine it with the tags, file name, current folder and length. Very short is probably a sound effect, long with no beat and no speech may be ambience. For anything that might be speech, run `speech` (if the user wanted sound analysis). Never pretend to have listened: say which clues you used.
   - Vector files (.svg) are graphics: put them in Pictures/Graphics and design unless they clearly show something else.
   - Data files (.json, .csv, .xml) go to Other/Project files; text, PDF, spreadsheet and slide files go to Other/Documents.
   - If you cannot decide, use that top folder's "Not sure" sub-folder; if you cannot even tell the type, the top-level "Not sure".
4. Write a plan as a table (file, folder, and new name only if renaming) and show it. Keep the original file names. Only if the user asked for renaming, add `new_name`: a short name that says what is in the file, e.g. beach_sunset_01 (keep the file ending). Wait for "go".
5. Save the plan as `plan.json`: a list of objects with `old` and `folder` (and `new_name` only when renaming). Run `python3 <skill folder>/scripts/sorter.py apply "<folder>" plan.json`.
6. Report how many files went in each folder and which went to "Not sure".
7. If the user asks to undo: `python3 <skill folder>/scripts/sorter.py undo "<folder>"`.

