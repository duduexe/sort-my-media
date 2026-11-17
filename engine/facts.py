#!/usr/bin/env python3
"""Sort my Media: collect clues about each file so Claude can sort it.

Usage: python facts.py <cache_dir> <list.json> <out.json>
  list.json = [{"i": 0, "path": "/full/path", "t": "pic|vid|snd|oth"}, ...]

Only READS her files. Everything it makes (preview pictures, still frames, short sound
clips) goes into <cache_dir>, never next to her files. Results are kept per file
(path + size + date changed), so a second look at the same files is quick.

Pictures: size in pixels and a preview picture (sips).
Videos:   length, size, 4 still frames on one picture (ffmpeg), and the sound clues below.
Sounds:   loudness, share of silence, beat (tempo) and brightness (librosa if installed),
          and the first 30 seconds as text (faster-whisper if installed).
Other:    the first few lines of small text files.
Prints "PROGRESS <done> <total> <name>" lines while it works.
"""
import hashlib, json, os, shutil, subprocess, sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "sort-my-media", "scripts"))
from sorter import probe  # noqa: E402  (same file facts as the sorting engine)

VERSION = "1"
FFMPEG = shutil.which("ffmpeg")
TEXTISH = {".json", ".csv", ".txt", ".md", ".xml", ".srt", ".vtt", ".html", ".svg"}

_whisper = None
_whisper_failed = None


def whisper():
    """Loads the small speech model once (downloaded during setup)."""
    global _whisper, _whisper_failed
    if _whisper is None and _whisper_failed is None:
        try:
            from faster_whisper import WhisperModel
            _whisper = WhisperModel("tiny", compute_type="int8")
        except Exception as e:  # not installed or model missing: sort without speech
            _whisper_failed = str(e)[:200]
    return _whisper


def has_librosa():
    try:
        import librosa  # noqa: F401
        return True
    except Exception:
        return False


def run(args, timeout=120):
    try:
        return subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    except Exception:
        return None


def sound_facts(path, seconds, work):
    """Loudness and silence for the first 5 minutes, then beat, brightness and words from a short clip."""
    out = {}
    if not FFMPEG:
        return {"note": "ffmpeg missing"}
    r = run(["ffmpeg", "-v", "info", "-t", "300", "-i", path, "-af",
             "volumedetect,silencedetect=n=-40dB:d=0.5", "-vn", "-f", "null", "-"], 180)
    err = r.stderr if r else ""
    for line in err.splitlines():
        if "mean_volume" in line:
            out["mean_volume_db"] = float(line.split("mean_volume:")[1].split()[0])
        if "max_volume" in line:
            out["max_volume_db"] = float(line.split("max_volume:")[1].split()[0])
    silent = sum(float(l.split("silence_duration:")[1]) for l in err.splitlines() if "silence_duration:" in l)
    span = min(seconds or 0, 300)
    if span:
        out["silent_share"] = round(min(silent / span, 1), 2)

    clip = os.path.join(work, "clip.wav")
    run(["ffmpeg", "-y", "-v", "error", "-i", path, "-t", "30", "-vn", "-ac", "1", "-ar", "16000", clip], 120)
    if not os.path.exists(clip) or os.path.getsize(clip) < 2000:
        return out
    try:
        if has_librosa():
            import librosa, numpy as np
            y, sr = librosa.load(clip, sr=None, mono=True)
            if len(y) > sr:  # a beat needs at least a second
                tempo = librosa.beat.beat_track(y=y, sr=sr)[0]
                out["tempo_bpm"] = int(np.round(np.atleast_1d(tempo)[0]))
            out["brightness_hz"] = int(librosa.feature.spectral_centroid(y=y, sr=sr).mean())
    except Exception as e:
        out["music_note"] = f"beat check failed: {str(e)[:120]}"
    # Words: skip very short or silent clips (sound effects), they only give made-up words.
    if (seconds or 0) >= 1.5 and out.get("silent_share", 0) < 0.9:
        m = whisper()
        if m is not None:
            try:
                segs, info = m.transcribe(clip, vad_filter=True, beam_size=1)
                segs = list(segs)
                text = " ".join(s.text.strip() for s in segs).strip()
                talk = sum(s.end - s.start for s in segs)
                out["speech"] = {
                    "text": text[:600],
                    "language": info.language,
                    "seconds_of_talking_in_first_30s": round(talk, 1),
                    "sure_it_is_speech": round(1 - (sum(s.no_speech_prob for s in segs) / len(segs)), 2) if segs else 0,
                }
            except Exception as e:
                out["speech_note"] = f"speech check failed: {str(e)[:120]}"
    try:
        os.remove(clip)  # our own temporary clip in the cache, never her file
    except OSError:
        pass
    return out


def picture_facts(path, work):
    out = {}
    ext = os.path.splitext(path)[1].lower()
    if ext == ".svg":
        try:
            with open(path, "r", errors="replace") as f:
                out["svg_start"] = f.read(1500)
        except OSError:
            pass
        return out
    r = run(["sips", "-g", "pixelWidth", "-g", "pixelHeight", path], 30)
    if r:
        w = h = None
        for line in r.stdout.splitlines():
            if "pixelWidth" in line:
                w = line.split(":")[1].strip()
            if "pixelHeight" in line:
                h = line.split(":")[1].strip()
        if w and h:
            out["pixels"] = f"{w}x{h}"
    prev = os.path.join(work, "preview.jpg")
    run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "70", "-Z", "768", path, "--out", prev], 60)
    if os.path.exists(prev) and os.path.getsize(prev) > 0:
        out["look_at"] = prev
    return out


def video_facts(path, info, work):
    out = {}
    secs = info.get("seconds") or 1
    if FFMPEG:
        shots = []
        for k in range(4):
            shot = os.path.join(work, f"f{k}.jpg")
            run(["ffmpeg", "-y", "-v", "error", "-ss", str(round(secs * (k + 0.5) / 4, 2)), "-i", path,
                 "-frames:v", "1", "-vf", "scale=384:-2", shot], 60)
            if os.path.exists(shot) and os.path.getsize(shot) > 0:
                shots.append(shot)
        if shots:
            sheet = os.path.join(work, "frames.jpg")
            # The 4 frames side by side in a 2 x 2 grid, in time order (top left first).
            run(["ffmpeg", "-y", "-v", "error", "-i", os.path.join(work, "f%d.jpg"), "-vf",
                 f"tile=2x2:padding=4:color=white", "-frames:v", "1", sheet], 60)
            if os.path.exists(sheet) and os.path.getsize(sheet) > 0:
                out["look_at"] = sheet
                out["look_at_note"] = "4 moments of the video, in time order: top left, top right, bottom left, bottom right"
                for s in shots:
                    os.remove(s)
            else:
                out["look_at"] = shots[0]
    if info.get("has_audio_stream"):
        out["sound"] = sound_facts(path, secs, work)
    else:
        out["sound"] = "no sound track"
    return out


def other_facts(path):
    ext = os.path.splitext(path)[1].lower()
    if ext in TEXTISH and os.path.getsize(path) < 5_000_000:
        try:
            with open(path, "r", errors="replace") as f:
                return {"text_start": f.read(400)}
        except OSError:
            pass
    return {}


def date_of(path, st):
    """Date taken from the file's own information (photos and clips), otherwise the day it was created."""
    r = run(["mdls", "-raw", "-name", "kMDItemContentCreationDate", path], 20)
    raw = (r.stdout if r else "").strip()
    if raw and raw != "(null)":
        try:
            from datetime import datetime
            d = datetime.strptime(raw[:25], "%Y-%m-%d %H:%M:%S %z").astimezone()
            if d.year > 1990:  # 1980 or 1970 are empty dates from downloads and zips
                return d.strftime("%Y-%m-%d %H:%M"), "taken"
        except ValueError:
            pass
    from datetime import datetime
    t = getattr(st, "st_birthtime", None) or st.st_mtime
    return datetime.fromtimestamp(t).strftime("%Y-%m-%d %H:%M"), "created"


def quality(img, sheet=False):
    """Sharpness (how crisp the edges are) and brightness (0 dark to 255 light) of a picture or of the 4 video moments.
    Uses numpy and scipy if they are there; without them, no quality badges."""
    try:
        import numpy as np
        from scipy import ndimage
    except Exception:
        return None
    try:
        raw = subprocess.run(["ffmpeg", "-v", "error", "-i", img, "-vf", "scale=256:256,format=gray", "-f", "rawvideo", "-"],
                             capture_output=True, timeout=60).stdout
        a = np.frombuffer(raw, dtype=np.uint8)
        if a.size != 256 * 256:
            return None
        a = a.reshape(256, 256).astype(np.float32)
    except Exception:
        return None
    parts = [a[6:122, 6:122], a[6:122, 134:250], a[134:250, 6:122], a[134:250, 134:250]] if sheet else [a]
    sharp = [float(ndimage.laplace(p).var()) for p in parts]
    bright = [float(p.mean()) for p in parts]
    return {"sharp": round(sorted(sharp)[len(sharp) // 2], 1), "bright": round(sum(bright) / len(bright), 1),
            "dark_all": all(b < 18 for b in bright), "spread": round(float(a.std()), 1)}


def facts_for(item, cache):
    path = item["path"]
    st = os.stat(path)
    key = hashlib.sha1(f"{VERSION}|{path}|{st.st_size}|{int(st.st_mtime)}".encode()).hexdigest()
    work = os.path.join(cache, key)
    done = os.path.join(work, "facts.json")
    if os.path.exists(done):
        with open(done) as f:
            out = json.load(f)
        changed = False
        if "date" not in out or str(out.get("date", "")) < "1991":  # clues made before dates were kept, or an empty 1980 date
            out["date"], out["date_from"] = date_of(path, st)
            changed = True
        if "quality" not in out and out.get("look_at") and os.path.exists(out["look_at"]):
            out["quality"] = quality(out["look_at"], sheet=out["look_at"].endswith("frames.jpg"))
            changed = True
        if changed:
            with open(done, "w") as f:
                json.dump(out, f, ensure_ascii=False)
        return out
    os.makedirs(work, exist_ok=True)
    t = item["t"]
    out = {"name": os.path.basename(path), "folder": os.path.basename(os.path.dirname(path)),
           "size_mb": round(st.st_size / 1e6, 2)}
    out["date"], out["date_from"] = date_of(path, st)
    if t == "pic":
        out.update(picture_facts(path, work))
    elif t in ("vid", "snd"):
        info = probe(path)
        for k in ("seconds", "pixels", "tags"):
            if info.get(k):
                out[k] = info[k]
        if t == "vid":
            out.update(video_facts(path, info, work))
        elif info.get("has_audio_stream", True):
            out["sound"] = sound_facts(path, info.get("seconds"), work)
    else:
        out.update(other_facts(path))
    if out.get("look_at") and os.path.exists(out["look_at"]):
        out["quality"] = quality(out["look_at"], sheet=out["look_at"].endswith("frames.jpg"))
    with open(done, "w") as f:
        json.dump(out, f, ensure_ascii=False)
    return out


def main():
    cache, list_path, out_path = sys.argv[1:4]
    os.makedirs(cache, exist_ok=True)
    with open(list_path) as f:
        items = json.load(f)
    result = []
    for n, item in enumerate(items):
        try:
            facts = facts_for(item, cache)
        except Exception as e:
            facts = {"name": os.path.basename(item["path"]), "note": f"could not read: {str(e)[:120]}"}
        result.append({"i": item["i"], "kind": item["t"], **facts})
        print(f"PROGRESS {n + 1} {len(items)} {os.path.basename(item['path'])}", flush=True)
    with open(out_path, "w") as f:
        json.dump(result, f, ensure_ascii=False, indent=1)
    tools = {"speech": _whisper is not None or (_whisper_failed is None and None), "music": has_librosa()}
    if _whisper_failed:
        tools["speech_note"] = _whisper_failed
    print("TOOLS " + json.dumps(tools), flush=True)


if __name__ == "__main__":
    main()
