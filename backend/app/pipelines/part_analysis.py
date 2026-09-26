"""Analysis of a recorded bass line, vocal or drum part.

The riff analyzer (riff_analysis.py) reads chords straight from a harmonic
recording. A bass line, a vocal and a drum part don't carry full chords, so
each gets its own reading, in the same result shape:

- bass:   notes by pitch tracking (pYIN); each bar's chord is built on the
          root the bass leans on, spelled in the detected key
- vocals: notes by pitch tracking; each bar is harmonized with the diatonic
          triad that covers the most sung time, favouring I, IV, V and vi
- drums:  hits by onset, sorted into kick, snare and hat by band energy; the
          kick pattern becomes the groove. Drums have no pitch, so key and
          chords are left for the user to pick.

Tempo and bar 1 come from the click when the take was recorded to it
(tempo_hint / start_hint), otherwise they are detected as for riffs.
"""

from typing import List, Optional

import numpy as np

from pipelines.composer import parse_key, diatonic_chord, scale_of, spell, NOTE_NAMES
from pipelines.riff_analysis import _tempo, _beat_phase, _key_name, _KK_MAJOR, _KK_MINOR, SR, HOP, MAX_SECONDS, MIN_SECONDS

KINDS = ("bass", "vocals", "drums")


def _load(wav_path: str):
    import librosa
    try:
        y, _ = librosa.load(wav_path, sr=SR, mono=True, duration=MAX_SECONDS)
    except Exception as exc:
        raise ValueError(f"Cannot read audio: {exc}")
    if len(y) / SR < MIN_SECONDS:
        raise ValueError(f"The recording is too short to analyze. Play at least {int(MIN_SECONDS)} seconds.")
    if float(np.max(np.abs(y))) < 1e-3:
        raise ValueError("The recording is silent.")
    return y


def _grid(y, tempo_hint, start_hint):
    """Tempo (BPM), its confidence and options, and where bar 1 starts (seconds)."""
    import librosa
    frame_rate = SR / HOP
    oenv = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    detected, conf = _tempo(oenv, frame_rate)
    tempo = float(tempo_hint) if tempo_hint else detected
    if start_hint is not None:
        start = float(start_hint)
    else:
        onsets = librosa.onset.onset_detect(onset_envelope=oenv, sr=SR, hop_length=HOP, units="time", backtrack=True)
        start = float(onsets[0]) if len(onsets) else _beat_phase(oenv, 60.0 / tempo * frame_rate) / frame_rate
    t = int(round(tempo))
    options = sorted({a for a in (int(round(tempo / 2)), t, int(round(tempo * 2)), int(round(detected))) if 40 <= a <= 240})
    return tempo, detected, conf, options, max(0.0, start)


def _notes(y, fmin, fmax, start, spb):
    """Monophonic note list from pYIN: [{p, t, d, v}] with t and d in beats from bar 1."""
    import librosa
    sr = 11025  # plenty for pitch tracking, and four times cheaper than full rate
    ys = librosa.resample(y, orig_sr=SR, target_sr=sr)
    hop = 128
    frame = 2048 if fmin < 60 else 1024
    f0, voiced, _ = librosa.pyin(ys, fmin=fmin, fmax=fmax, sr=sr, frame_length=frame, hop_length=hop)
    midi = np.where(voiced, librosa.hz_to_midi(np.nan_to_num(f0, nan=1.0)), np.nan)
    rms = librosa.feature.rms(y=ys, frame_length=frame, hop_length=hop)[0]
    onset_frames = set(librosa.onset.onset_detect(y=ys, sr=sr, hop_length=hop, backtrack=True).tolist())
    ft = hop / sr
    peak_rms = float(rms.max()) or 1.0

    notes, cur = [], None

    def close(end_frame):
        if cur and (end_frame - cur["a"]) * ft >= 0.06:
            p = int(round(float(np.median(cur["m"]))))
            level = float(np.max(rms[cur["a"]:end_frame + 1])) / peak_rms
            t0 = cur["a"] * ft
            notes.append({"p": p, "t": round((t0 - start) / spb, 3), "d": round((end_frame - cur["a"]) * ft / spb, 3),
                          "v": int(max(30, min(127, round(40 + 87 * level))))})

    for i, m in enumerate(midi):
        if np.isnan(m):
            close(i)
            cur = None
            continue
        if cur is None:
            cur = {"a": i, "m": [m]}
        elif abs(m - np.median(cur["m"])) > 0.6 or (i in onset_frames and i - cur["a"] > 3):
            close(i)
            cur = {"a": i, "m": [m]}
        else:
            cur["m"].append(m)
    close(len(midi) - 1)
    return [n for n in notes if n["t"] > -0.25]


def _key_from_notes(notes, tonic_hint: Optional[int]):
    hist = np.zeros(12)
    for n in notes:
        hist[n["p"] % 12] += n["d"]
    if hist.sum() == 0:
        raise ValueError("Couldn't hear any pitched notes. Record a little louder and closer to the mic.")
    c = hist - hist.mean()
    scores = []
    for root in range(12):
        for mode, prof in (("major", _KK_MAJOR), ("minor", _KK_MINOR)):
            p = np.roll(prof, root) - prof.mean()
            r = float(np.dot(c, p) / (np.linalg.norm(c) * np.linalg.norm(p) + 1e-12))
            scores.append((r, root, mode))
    scores.sort(reverse=True)
    # Relative major and minor share every note, so the profile alone can't
    # separate them. If the line starts (bass) or lands (vocals) on the tonic
    # of the relative key, that one wins.
    _, top_root, top_mode = scores[0]
    rel = ((top_root + 9) % 12, "minor") if top_mode == "major" else ((top_root + 3) % 12, "major")
    if tonic_hint is not None and rel[0] == tonic_hint:
        i = next(k for k, s in enumerate(scores) if (s[1], s[2]) == rel)
        scores.insert(0, (scores[0][0], rel[0], rel[1]))
        del scores[i + 1]
    rs = np.array([s[0] for s in scores])
    probs = np.exp(rs * 12)
    probs /= probs.sum()
    return scores, float(probs[0])


def _triad_pcs(key, degree):
    sc = scale_of(key)
    return [sc[degree % 7], sc[(degree + 2) % 7], sc[(degree + 4) % 7]]


# Pitch tracking puts onsets a hair early; a 32nd of slack keeps a downbeat
# note in its own bar instead of the one before
SLACK = 0.125


def _bars_of(notes, bars):
    out = [[] for _ in range(bars)]
    for n in notes:
        b = int((n["t"] + SLACK) // 4)
        if 0 <= b < bars:
            out[b].append(n)
    return out


def _bass_chords(notes, bars, key):
    """Chord per bar on the root the bass leans on (downbeat notes count double)."""
    sc = scale_of(key)
    per_bar = _bars_of(notes, bars)
    out = []
    prev = diatonic_chord(key, 0, False)
    for i, ns in enumerate(per_bar):
        if not ns:
            out.append({"bar": i + 1, "chord": prev, "options": [prev], "confidence": 30})
            continue
        w = np.zeros(12)
        for n in ns:
            w[n["p"] % 12] += n["d"] * (2.0 if ((n["t"] + SLACK) % 4) < 0.25 else 1.0)
        root = int(np.argmax(w))
        conf = int(round(100 * w[root] / w.sum()))
        if root in sc:
            main = diatonic_chord(key, sc.index(root), False)
        else:
            main = spell(root, key["flats"])
        # Other diatonic chords that contain that bass note (bass on the 3rd or 5th)
        alts = [diatonic_chord(key, d, False) for d in range(7) if root in _triad_pcs(key, d) and sc[d] != root]
        options = [main] + [a for a in alts if a != main][:3]
        out.append({"bar": i + 1, "chord": main, "options": options, "confidence": conf})
        prev = main
    return out


_PRIOR = {0: 0.10, 3: 0.06, 4: 0.06, 5: 0.05}  # I, IV, V, vi


def _vocal_chords(notes, bars, key):
    """Harmonize each bar with the diatonic triad covering the most sung time."""
    per_bar = _bars_of(notes, bars)
    out = []
    prev = diatonic_chord(key, 0, False)
    for i, ns in enumerate(per_bar):
        total = sum(n["d"] for n in ns)
        if total <= 0:
            out.append({"bar": i + 1, "chord": prev, "options": [prev], "confidence": 30})
            continue
        ranked = []
        for d in range(7):
            pcs = _triad_pcs(key, d)
            score = 0.0
            for n in ns:
                pc = n["p"] % 12
                strong = 1.5 if ((n["t"] + SLACK) % 2) < 0.25 else 1.0
                if pc in pcs:
                    score += n["d"] * strong * (1.4 if pc == pcs[0] else 1.0)
            if d == 6:
                score *= 0.7  # the diminished vii rarely harmonizes a sung line
            ranked.append((score / total + _PRIOR.get(d, 0) + (0.08 if i == 0 and d == 0 else 0), d))
        ranked.sort(reverse=True)
        names = [diatonic_chord(key, d, False) for _, d in ranked[:4]]
        margin = ranked[0][0] - ranked[1][0]
        out.append({"bar": i + 1, "chord": names[0], "options": names,
                    "confidence": int(round(100 * max(0.0, min(1.0, 0.5 + margin * 2))))})
        prev = names[0]
    return out


def _drum_hits(y, start, spb):
    """Onsets sorted by band level relative to the loudest hit in each band.

    Relative levels hold up when a snare and a hat land together, where the
    within-hit ratios used for beatbox blur: a kick carries tens of times more
    low end than anything else in the kit, a snare tens of times more mids
    than a hat.
    """
    import librosa
    onsets = librosa.onset.onset_detect(y=y, sr=SR, hop_length=HOP, backtrack=True, units="time")
    win = int(0.06 * SR)
    feats = []
    for t in onsets:
        a = int(t * SR)
        chunk = y[a:a + win]
        if len(chunk) < 64:
            continue
        mag = np.abs(np.fft.rfft(chunk))
        freqs = np.fft.rfftfreq(len(chunk), 1.0 / SR)
        band = lambda lo, hi: float(np.sqrt(np.mean(mag[(freqs >= lo) & (freqs < hi)] ** 2)))
        feats.append((t, band(20, 150), band(150, 4000), float(np.max(np.abs(chunk)))))
    if not feats:
        return []
    max_low = max(f[1] for f in feats) or 1e-9
    max_mid = max(f[2] for f in feats) or 1e-9
    peak = max(f[3] for f in feats) or 1.0
    hits = []
    for t, low, mid, level in feats:
        lane = "kick" if low / max_low >= 0.25 else "snare" if mid / max_mid >= 0.3 else "hat"
        hits.append({"lane": lane, "t": round((t - start) / spb, 3), "v": int(max(30, min(127, round(127 * level / peak))))})
    return hits


def _groove(beats: List[float], bars: int) -> List[float]:
    """Positions in the bar (16ths) that recur in at least a third of the bars."""
    counts = {}
    for b in beats:
        if b < -0.125 or b >= bars * 4:
            continue
        pos = (round(b * 4) / 4) % 4
        counts[pos] = counts.get(pos, 0) + 1
    out = sorted(p for p, n in counts.items() if n >= max(1, bars / 3))
    if 0.0 not in out:
        out.insert(0, 0.0)
    return out[:8]


def analyze_part(wav_path: str, kind: str, tempo_hint: Optional[float] = None, start_hint: Optional[float] = None) -> dict:
    if kind not in KINDS:
        raise ValueError(f"kind must be one of {KINDS}")
    y = _load(wav_path)
    duration = len(y) / SR
    tempo, detected, tempo_conf, tempo_options, start = _grid(y, tempo_hint, start_hint)
    spb = 60.0 / tempo
    bars = max(1, min(32, int((duration - start) / (4 * spb) + 0.25)))

    n_bins = 400
    step = max(1, len(y) // n_bins)
    peaks = [round(float(np.max(np.abs(y[i * step:(i + 1) * step]))), 3) for i in range(n_bins) if i * step < len(y)]

    result = {
        "kind": kind, "duration": round(duration, 3), "tempo": round(tempo, 1), "detected_tempo": round(detected, 1),
        "tempo_confidence": int(round(100 * tempo_conf)), "tempo_options": tempo_options,
        "start": round(start, 3), "bars": bars, "peaks": peaks,
    }

    if kind == "drums":
        hits = _drum_hits(y, start, spb)
        if not hits:
            raise ValueError("Couldn't hear any drum hits.")
        kicks = [h["t"] for h in hits if h["lane"] == "kick"]
        result.update({
            "key": None, "key_confidence": 0, "key_options": [], "chords": [],
            "hits": [h for h in hits if 0 <= h["t"] < bars * 4],
            "groove": _groove(kicks, bars),
            "accents": [{"time": round(start + h["t"] * spb, 3), "beat": h["t"], "strength": int(round(100 * h["v"] / 127))}
                        for h in hits if h["lane"] in ("kick", "snare")][:128],
        })
        return result

    fmin, fmax = (30.0, 400.0) if kind == "bass" else (70.0, 1100.0)
    notes = _notes(y, fmin, fmax, start, spb)
    if len(notes) < 2:
        raise ValueError("Couldn't hear clear notes. Record a little louder and closer to the mic.")
    in_song = [n for n in notes if -SLACK <= n["t"] < bars * 4]
    if kind == "bass":
        first = min(in_song, key=lambda n: n["t"])["p"] % 12 if in_song else None
        tonic_hint = first
    else:
        # A sung line usually lands on the tonic
        tonic_hint = max(in_song, key=lambda n: n["t"])["p"] % 12 if in_song else None
    scores, key_conf = _key_from_notes(in_song or notes, tonic_hint)
    _, k_root, k_mode = scores[0]
    key = parse_key(f"{NOTE_NAMES[k_root]} {k_mode}")
    chords = _bass_chords(in_song, bars, key) if kind == "bass" else _vocal_chords(in_song, bars, key)
    result.update({
        "key": key["name"], "key_confidence": int(round(100 * key_conf)),
        "key_options": [_key_name(r, m) for _, r, m in scores[:3]],
        "chords": chords,
        "notes": in_song,
        "groove": _groove([n["t"] for n in in_song], bars) if kind == "bass" else [0.0, 2.0],
        "accents": [{"time": round(start + n["t"] * spb, 3), "beat": n["t"], "strength": int(round(100 * n["v"] / 127))} for n in in_song][:128],
    })
    return result
