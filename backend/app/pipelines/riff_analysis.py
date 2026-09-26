"""Riff analysis for the "Start from your own riff" screen.

Reads a short recording (guitar, keys, anything harmonic) and reports what the
UI needs so the user can confirm or correct it before anything is built:

- tempo, with a confidence and the half/double alternatives beat trackers
  commonly confuse
- where bar 1 starts and how many whole bars were played (4/4 assumed)
- key, with a confidence and the next most likely keys
- one chord per bar, with ranked alternatives
- strum accents (strong onsets) positioned in beats
- a downsampled peak envelope for the waveform strip

Tempo comes from a comb over the onset-strength autocorrelation rather than
librosa.beat.beat_track, because beat_track's 120 BPM prior pulls clean
strummed riffs away from their real tempo.
"""

from typing import List, Optional

import numpy as np

from pipelines.composer import NOTE_NAMES, spell, FLAT_MAJOR, FLAT_MINOR

SR = 22050
HOP = 256
MAX_SECONDS = 60.0
MIN_SECONDS = 2.0

# Krumhansl-Kessler key profiles
_KK_MAJOR = np.array([6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88])
_KK_MINOR = np.array([6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17])


def _triad_templates():
    out = []
    for root in range(12):
        for q, ivs in (("", (0, 4, 7)), ("m", (0, 3, 7))):
            t = np.zeros(12)
            t[root] = 1.0
            t[(root + ivs[1]) % 12] = 0.8
            t[(root + ivs[2]) % 12] = 0.8
            out.append((root, q, t / np.linalg.norm(t)))
    return out


_TRIADS = _triad_templates()


def _autocorr(x: np.ndarray) -> np.ndarray:
    x = x - x.mean()
    n = len(x)
    f = np.fft.rfft(x, 2 * n)
    ac = np.fft.irfft(f * np.conj(f))[:n]
    return ac / (ac[0] + 1e-12)


def _tempo(oenv: np.ndarray, frame_rate: float):
    ac = _autocorr(oenv)
    lags = np.arange(len(ac))

    def comb(bpm):
        period = 60.0 / bpm * frame_rate
        total, k = 0.0, 1
        while k * period < len(ac) - 1 and k <= 8:
            total += float(np.interp(k * period, lags, ac)) / k ** 0.5
            k += 1
        return total

    bpms = np.arange(50.0, 220.5, 0.5)
    scores = np.array([comb(b) for b in bpms])
    # Refine around the winner at 0.1 BPM resolution
    best = float(bpms[int(np.argmax(scores))])
    fine = np.arange(best - 1.0, best + 1.05, 0.1)
    fine_scores = np.array([comb(b) for b in fine])
    best = float(fine[int(np.argmax(fine_scores))])
    peak = float(fine_scores.max())

    # Confidence: how far the winner stands above the best candidate that is
    # not the same tempo or a simple ratio of it.
    def related(b):
        return any(abs(b / best - r) < 0.04 for r in (0.5, 2 / 3, 1.0, 1.5, 2.0))

    rivals = [s for b, s in zip(bpms, scores) if not related(b)]
    rival = max(rivals) if rivals else 0.0
    conf = 0.0 if peak <= 0 else max(0.0, min(1.0, (peak - max(rival, 0.0)) / peak))
    return best, conf


def _beat_phase(oenv: np.ndarray, period: float) -> float:
    """Frame offset of the beat grid that best lines up with onsets."""
    best_off, best_score = 0.0, -1.0
    idx = np.arange(len(oenv))
    for off in np.arange(0.0, period, 0.5):
        pos = np.arange(off, len(oenv) - 1, period)
        score = float(np.interp(pos, idx, oenv).sum())
        if score > best_score:
            best_off, best_score = off, score
    return best_off


def _key(chroma_mean: np.ndarray, first_chord_root: int, first_chord_minor: bool):
    c = chroma_mean - chroma_mean.mean()
    scores = []
    for root in range(12):
        for mode, prof in (("major", _KK_MAJOR), ("minor", _KK_MINOR)):
            p = np.roll(prof, root)
            p = p - p.mean()
            r = float(np.dot(c, p) / (np.linalg.norm(c) * np.linalg.norm(p) + 1e-12))
            # Riffs almost always open on the tonic chord. Relative major and
            # minor share every pitch, so this is what separates them.
            if root == first_chord_root and (mode == "minor") == first_chord_minor:
                r += 0.15
            scores.append((r, root, mode))
    scores.sort(reverse=True)
    rs = np.array([s[0] for s in scores])
    probs = np.exp(rs * 12)
    probs = probs / probs.sum()
    return scores, probs


def _key_name(root: int, mode: str) -> str:
    flats = root in (FLAT_MINOR if mode == "minor" else FLAT_MAJOR)
    return f"{spell(root, flats)} {mode}"


def analyze_riff(wav_path: str, tempo_hint: Optional[float] = None, start_hint: Optional[float] = None) -> dict:
    """Analyze a riff recording. Raises ValueError when the audio can't be used.

    A riff recorded to the app's click already has a known tempo and a known
    bar 1 (start_hint, seconds). When given, those set the bar grid instead of
    being detected, so chords are read bar by bar on the grid the user played to.
    """
    import librosa

    try:
        y, sr = librosa.load(wav_path, sr=SR, mono=True, duration=MAX_SECONDS)
    except Exception as exc:
        raise ValueError(f"Cannot read audio: {exc}")
    duration = len(y) / SR
    if duration < MIN_SECONDS:
        raise ValueError(f"Riff is too short to analyze. Play at least {int(MIN_SECONDS)} seconds.")
    if float(np.max(np.abs(y))) < 1e-3:
        raise ValueError("The recording is silent.")

    frame_rate = SR / HOP
    oenv = librosa.onset.onset_strength(y=y, sr=SR, hop_length=HOP)
    detected, tempo_conf = _tempo(oenv, frame_rate)
    tempo = float(tempo_hint) if tempo_hint else detected
    period = 60.0 / tempo * frame_rate
    beat_off = _beat_phase(oenv, period)

    chroma = librosa.feature.chroma_cqt(y=y, sr=SR, hop_length=HOP)
    n_frames = chroma.shape[1]

    # Pick which of the 4 beat phases is the downbeat: chords change on bar
    # lines, so the right phase gives the most distinct per-bar chroma.
    def bar_chromas(start_frame):
        out = []
        bar_len = period * 4
        s = start_frame
        while s + bar_len * 0.75 <= n_frames:
            a, b = int(round(s)), int(round(min(n_frames, s + bar_len)))
            out.append(chroma[:, a:b].mean(axis=1))
            s += bar_len
        return out

    best_start, best_score = beat_off, -1.0
    for k in (range(4) if start_hint is None else ()):
        start = beat_off + k * period
        bcs = bar_chromas(start)
        if len(bcs) < 1:
            continue
        # Score: how well each bar is explained by a single triad
        fit = np.mean([max(float(np.dot(bc / (np.linalg.norm(bc) + 1e-12), t)) for _, _, t in _TRIADS) for bc in bcs])
        onset_at = float(np.interp(start, np.arange(len(oenv)), oenv)) / (oenv.max() + 1e-12)
        score = fit + 0.05 * onset_at - 0.001 * k
        if score > best_score:
            best_start, best_score = start, score
    # Step back whole bars while a full bar still fits before the chosen start
    while best_start - period * 4 >= -period * 0.25:
        best_start -= period * 4
    best_start = max(0.0, best_start)
    if start_hint is not None:
        best_start = start_hint * frame_rate

    bcs = bar_chromas(best_start)[:32]
    if not bcs:
        raise ValueError("Couldn't find a whole bar in this recording. Play at least one full bar.")

    bar_candidates = []
    for bc in bcs:
        v = bc / (np.linalg.norm(bc) + 1e-12)
        ranked = sorted(((float(np.dot(v, t)), root, q) for root, q, t in _TRIADS), reverse=True)
        bar_candidates.append(ranked)

    first = bar_candidates[0][0]
    key_scores, key_probs = _key(chroma.mean(axis=1), first[1], first[2] == "m")
    _, k_root, k_mode = key_scores[0]
    flats = k_root in (FLAT_MINOR if k_mode == "minor" else FLAT_MAJOR)

    bars = []
    for i, ranked in enumerate(bar_candidates):
        names = []
        for score, root, q in ranked:
            name = spell(root, flats) + q
            if name not in names:
                names.append(name)
            if len(names) == 4:
                break
        top = ranked[0][0]
        second = ranked[1][0]
        bars.append({
            "bar": i + 1,
            "chord": names[0],
            "options": names,
            "confidence": int(round(100 * max(0.0, min(1.0, (top - second) * 8 + 0.5)))),
        })

    # Tempo alternatives: half and double are the classic beat-tracking errors
    t_int = int(round(tempo))
    alts = sorted({a for a in (int(round(tempo / 2)), t_int, int(round(tempo * 2)), int(round(detected))) if 40 <= a <= 240})

    # Onset attacks, backtracked from the flux peak to where the note starts
    peak_frames = librosa.onset.onset_detect(onset_envelope=oenv, sr=SR, hop_length=HOP)
    attack_frames = librosa.onset.onset_backtrack(peak_frames, oenv) if len(peak_frames) else peak_frames
    beat_sec = 60.0 / tempo

    # The comb aligns to flux peaks, which trail the real attacks. Shift the
    # grid by the median gap between each beat and the attack nearest it,
    # then, if the recording starts sounding right at bar 1, snap to that.
    start_sec = best_start / frame_rate
    attack_secs = attack_frames / frame_rate
    if len(attack_secs) and start_hint is None:
        residuals = []
        k = 0
        while start_sec + k * beat_sec < duration:
            g = start_sec + k * beat_sec
            d = attack_secs - g
            j = int(np.argmin(np.abs(d)))
            if abs(d[j]) <= beat_sec / 6:
                residuals.append(float(d[j]))
            k += 1
        if residuals:
            start_sec += float(np.median(residuals))
    level = np.abs(y)
    first_sound = int(np.argmax(level > 0.1 * float(level.max()))) / SR
    if start_hint is None and abs(first_sound - start_sec) <= beat_sec / 8:
        start_sec = first_sound
    start_sec = max(0.0, start_sec)

    # Accents: strums louder than the ones around them. Scored by RMS just
    # after each attack (spectral flux tracks change, not loudness), relative
    # to the median of the neighbouring strums so chord register and a hit
    # out of silence don't skew it.
    accents = []
    if len(attack_frames) >= 3:
        rms = librosa.feature.rms(y=y, frame_length=1024, hop_length=HOP)[0]
        win = max(1, int(0.06 * frame_rate))
        # Window runs from the attack to just past the flux peak, since
        # backtracking can land well before the strum is at full level.
        levels = np.array([float(rms[a:p + win].max()) if a < len(rms) else 0.0
                           for a, p in zip(attack_frames, peak_frames)])
        for i, (af, level) in enumerate(zip(attack_frames, levels)):
            around = np.concatenate([levels[max(0, i - 3):i], levels[i + 1:i + 4]])
            ref = float(np.median(around)) if len(around) else level
            rel = level / ref if ref > 0 else 1.0
            if rel < 1.12:
                continue
            t = af / frame_rate
            accents.append({
                "time": round(float(t), 3),
                "beat": round((t - start_sec) / beat_sec, 2),
                "strength": int(round(100 * min(1.0, (rel - 1.0) / 0.5))),
            })
    accents = accents[:128]

    n_bins = 400
    step = max(1, len(y) // n_bins)
    peaks = [round(float(np.max(np.abs(y[i * step:(i + 1) * step]))), 3) for i in range(n_bins) if i * step < len(y)]

    return {
        "duration": round(duration, 3),
        "tempo": round(tempo, 1),
        "detected_tempo": round(detected, 1),
        "tempo_confidence": int(round(100 * tempo_conf)),
        "tempo_options": alts,
        "start": round(start_sec, 3),
        "bars": len(bars),
        "key": _key_name(k_root, k_mode),
        "key_confidence": int(round(100 * float(key_probs[0]))),
        "key_options": [_key_name(r, m) for _, r, m in key_scores[:3]],
        "chords": bars,
        "accents": accents,
        "peaks": peaks,
    }
