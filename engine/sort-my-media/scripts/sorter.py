#!/usr/bin/env python3
"""Small helper for the sort-my-media skill. Python 3 standard library only.

scan   <folder> [offset] [limit]  list files not yet sorted (type, size, length, size in pixels, audio tags); chunks for big folders
frames <file> [count]         save still frames from a video (needs ffmpeg)
audio  <file>                 loudness, silence share and (if installed) tempo and brightness of a sound or a video's sound
speech <file>                 transcribe the first 30 seconds (needs faster-whisper or openai-whisper)
apply  <folder> <plan.json>   rename and move files, log every move
undo   <folder>               put every moved file back
"""
import json, os, shutil, subprocess, sys

PHOTO = {".jpg", ".jpeg", ".png", ".heic", ".webp", ".gif", ".tif", ".tiff", ".svg"}
VIDEO = {".mp4", ".mov", ".m4v", ".avi", ".mkv", ".webm"}
AUDIO = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".aiff"}
WORK = "_sorter_work"
LOG = "move_log.json"
NAMES = "where files went.txt"


def kind(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in PHOTO: return "photo"
    if ext in VIDEO: return "video"
    if ext in AUDIO: return "audio"
    return "other"


def probe(path):
    if not shutil.which("ffprobe"):
        return {}
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", path],
            capture_output=True, text=True, timeout=60).stdout
        data = json.loads(out)
    except Exception:
        return {}
    fmt = data.get("format", {})
    vid = next((x for x in data.get("streams", []) if x.get("codec_type") == "video"), {})
    info = {"seconds": round(float(fmt["duration"]), 1) if "duration" in fmt else None,
            "pixels": f'{vid["width"]}x{vid["height"]}' if "width" in vid else None,
            "has_audio_stream": any(s.get("codec_type") == "audio" for s in data.get("streams", []))}
    tags = {k.lower(): v for k, v in fmt.get("tags", {}).items()}
    keep = {k: tags[k] for k in ("title", "artist", "album", "genre", "comment") if k in tags}
    if keep: info["tags"] = keep
    return info


def inside(root, path):
    root = os.path.realpath(root)
    path = os.path.realpath(path)
    return path == root or path.startswith(root + os.sep)


SORTED = {"Pictures", "Videos", "Sounds", "Other", "Not sure"}


def scan(folder, offset="0", limit="200"):
    """Lists files not yet sorted. Files already inside a sorted top folder are skipped,
    so a stopped run can simply be started again."""
    offset, limit = int(offset), int(limit)
    paths = []
    for dirpath, dirs, files in os.walk(folder):
        if os.path.abspath(dirpath) == os.path.abspath(folder):
            dirs[:] = [d for d in dirs if d != WORK and d not in SORTED]
        else:
            dirs[:] = [d for d in dirs if d != WORK]
        for f in sorted(files):
            if f in (NAMES, "plan.json"):
                continue
            paths.append(os.path.join(dirpath, f))
    rows = []
    for p in paths[offset:offset + limit]:
        row = {"file": os.path.relpath(p, folder), "type": kind(p), "mb": round(os.path.getsize(p) / 1e6, 2)}
        if row["type"] in ("video", "audio", "photo"):
            row.update(probe(p))
            if row["type"] == "audio": row.pop("pixels", None)
            if row["type"] == "photo": row.pop("seconds", None); row.pop("has_audio_stream", None)
            if p.lower().endswith(".svg"): row["pixels"] = "vector graphic"
        rows.append(row)
    print(json.dumps(rows, indent=1, ensure_ascii=False))
    print(f"showing {len(rows)} of {len(paths)} unsorted files (offset {offset})", file=sys.stderr)


def frames(path, count="4"):
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is not installed. Ask the user before installing it.")
    count = int(count)
    seconds = probe(path).get("seconds") or 1
    outdir = os.path.join(os.path.dirname(os.path.abspath(path)), WORK, "frames")
    os.makedirs(outdir, exist_ok=True)
    base = os.path.splitext(os.path.basename(path))[0]
    for i in range(count):
        t = seconds * (i + 0.5) / count
        out = os.path.join(outdir, f"{base}_{i + 1}.jpg")
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-ss", str(t), "-i", path, "-frames:v", "1",
                        "-vf", "scale=640:-2", out], check=False)
        if os.path.exists(out):
            print(out)


def audio(path):
    """Cheap facts about a sound. Uses ffmpeg; adds tempo and brightness if librosa is installed."""
    out = {}
    if shutil.which("ffmpeg"):
        r = subprocess.run(["ffmpeg", "-v", "info", "-i", path, "-af", "volumedetect,silencedetect=n=-40dB:d=0.5",
                            "-vn", "-f", "null", "-"], capture_output=True, text=True).stderr
        for line in r.splitlines():
            if "mean_volume" in line: out["mean_volume_db"] = float(line.split("mean_volume:")[1].split()[0])
            if "max_volume" in line: out["max_volume_db"] = float(line.split("max_volume:")[1].split()[0])
        silent = sum(float(l.split("silence_duration:")[1]) for l in r.splitlines() if "silence_duration:" in l)
        info = probe(path)
        if not info.get("has_audio_stream"):
            print(json.dumps({"has_sound": False}))
            return
        secs = info.get("seconds") or 0
        if secs: out["silent_share"] = round(min(silent / secs, 1), 2)
    try:
        import librosa, numpy as np
        y, sr = librosa.load(path, sr=22050, mono=True, duration=60)
        tempo = librosa.beat.beat_track(y=y, sr=sr)[0]
        out["tempo_bpm"] = int(np.round(np.atleast_1d(tempo)[0]))
        out["brightness_hz"] = int(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
    except ImportError:
        out["note"] = "librosa not installed: no tempo or brightness. Install with: pip install librosa"
    except Exception as e:
        out["note"] = f"analysis failed: {e}"
    print(json.dumps(out, indent=1))


def speech(path):
    """Transcribe the first 30 seconds. A clip with real words is speech; the text is also a naming clue."""
    if not shutil.which("ffmpeg"):
        sys.exit("ffmpeg is not installed. Ask the user before installing it.")
    if not probe(path).get("has_audio_stream"):
        print(json.dumps({"has_sound": False, "text": ""}))
        return
    tmp = os.path.join(os.path.dirname(os.path.abspath(path)), WORK, "speech.wav")
    os.makedirs(os.path.dirname(tmp), exist_ok=True)
    if os.path.exists(tmp):
        os.remove(tmp)  # our own temporary file, never a user file
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", path, "-t", "30", "-vn", "-ac", "1", "-ar", "16000", tmp], check=False)
    if not os.path.exists(tmp):
        print(json.dumps({"has_sound": False, "text": ""}))
        return
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        sys.exit('No speech tool installed. Ask the user, then install it (see SKILL.md): pip install faster-whisper "av<16"')
    try:
        segs, info = WhisperModel("tiny", compute_type="int8").transcribe(tmp)
        print(json.dumps({"has_sound": True, "language": info.language,
                          "text": " ".join(x.text.strip() for x in segs)}, ensure_ascii=False))
    except TypeError as e:
        sys.exit(f'The speech tool needs an older helper package. Run: pip install "av<16"  (details: {e})')


def unique(dest):
    if not os.path.exists(dest):
        return dest
    stem, ext = os.path.splitext(dest)
    n = 2
    while os.path.exists(f"{stem}_{n}{ext}"):
        n += 1
    return f"{stem}_{n}{ext}"


def apply(folder, plan_path):
    plan = json.load(open(plan_path, encoding="utf-8"))
    os.makedirs(os.path.join(folder, WORK), exist_ok=True)
    log_path = os.path.join(folder, WORK, LOG)
    log = json.load(open(log_path)) if os.path.exists(log_path) else []
    lines = []
    for item in plan:
        src = os.path.join(folder, item["old"])
        ext = os.path.splitext(src)[1]
        new = item.get("new_name") or os.path.basename(item["old"])
        if not new.lower().endswith(ext.lower()):
            new += ext
        sub = item["folder"].strip().strip("/\\")
        dest = os.path.join(folder, sub, new)
        if not os.path.isfile(src) or not inside(folder, src) or not inside(folder, dest):
            print("skipped (not found or outside folder):", item["old"])
            continue
        dest = unique(dest)
        os.makedirs(os.path.dirname(dest), exist_ok=True)
        shutil.move(src, dest)
        rel_dest = os.path.relpath(dest, folder)
        log.append({"old": item["old"], "new": rel_dest})
        lines.append(f"{item['old']}  ->  {rel_dest}")
    for top in ("Pictures", "Videos", "Sounds", "Other"):
        os.makedirs(os.path.join(folder, top, "Not sure"), exist_ok=True)
    os.makedirs(os.path.join(folder, "Not sure"), exist_ok=True)
    json.dump(log, open(log_path, "w"), indent=1, ensure_ascii=False)
    with open(os.path.join(folder, NAMES), "a", encoding="utf-8") as f:
        f.write("\n".join(lines) + ("\n" if lines else ""))
    print(f"moved {len(lines)} files; list in '{NAMES}'")


def undo(folder):
    log_path = os.path.join(folder, WORK, LOG)
    if not os.path.exists(log_path):
        sys.exit("Nothing to undo.")
    log = json.load(open(log_path))
    back = 0
    for entry in reversed(log):
        cur = os.path.join(folder, entry["new"])
        orig = os.path.join(folder, entry["old"])
        if os.path.isfile(cur) and not os.path.exists(orig):
            os.makedirs(os.path.dirname(orig), exist_ok=True)
            shutil.move(cur, orig)
            back += 1
    os.remove(log_path)
    print(f"restored {back} of {len(log)} files")


if __name__ == "__main__":
    a = sys.argv[1:]
    if len(a) >= 2 and a[0] == "scan": scan(*a[1:4])
    elif len(a) == 2 and a[0] == "audio": audio(a[1])
    elif len(a) == 2 and a[0] == "speech": speech(a[1])
    elif len(a) >= 2 and a[0] == "frames": frames(*a[1:3])
    elif len(a) == 3 and a[0] == "apply": apply(a[1], a[2])
    elif len(a) == 2 and a[0] == "undo": undo(a[1])
    else: print(__doc__)
