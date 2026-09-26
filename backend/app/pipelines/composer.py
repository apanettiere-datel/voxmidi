"""Studio composer -- deterministic, seeded arrangement writer.

Turns a description (genre, feel, tempo, key) into a project: a list of
sections with a chord cycle each, and four MIDI tracks (drums, bass, chords,
melody) whose notes are measured in beats from the top of the song.

Everything here is rule-based and runs in milliseconds on CPU, which is what
makes "regenerate a part" free to offer. The same inputs and seed always give
the same notes, so a regenerate is just a call with a new seed.

Note shape: {"p": midi pitch, "t": start beat, "d": length in beats,
             "v": velocity 1-127, "glide": bool (bass only, optional)}
"""

import random
import re
from typing import Dict, List, Optional

BEATS_PER_BAR = 4

NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
# Tonics (pitch class) whose key signature uses flats
FLAT_MAJOR = {5, 10, 3, 8, 1, 6}      # F Bb Eb Ab Db Gb
FLAT_MINOR = {2, 7, 0, 5, 10, 3}      # D G C F Bb Eb
FLAT_TO_SHARP = {"Db": "C#", "Eb": "D#", "Gb": "F#", "Ab": "G#", "Bb": "A#", "Cb": "B", "Fb": "E"}

MAJOR_SCALE = [0, 2, 4, 5, 7, 9, 11]
MINOR_SCALE = [0, 2, 3, 5, 7, 8, 10]

# GM drum notes used by the studio drum lanes
KICK, SNARE, CLAP, CHAT, OHAT, PERC = 36, 38, 39, 42, 46, 75
DRUM_PITCHES = {KICK, SNARE, CLAP, CHAT, OHAT, PERC}

SECTION_KINDS = ("Intro", "Verse", "Chorus", "Bridge", "Outro")
TRACK_IDS = ("drums", "bass", "chords", "melody")

GENRES: Dict[str, dict] = {
    "Lo-fi":     {"tempo": (72, 88),   "drums": "boombap",  "hat_div": 2, "bass": "round",   "sevenths": True,  "comp": "lazy"},
    "Trap":      {"tempo": (130, 150), "drums": "trap",     "hat_div": 4, "bass": "808",     "sevenths": False, "comp": "pad"},
    "Indie rock": {"tempo": (110, 132), "drums": "rock",    "hat_div": 2, "bass": "root",    "sevenths": False, "comp": "strum"},
    "Synthwave": {"tempo": (96, 118),  "drums": "backbeat", "hat_div": 4, "bass": "pulse",   "sevenths": False, "comp": "pad"},
    "R&B":       {"tempo": (64, 84),   "drums": "halftime", "hat_div": 4, "bass": "round",   "sevenths": True,  "comp": "lazy"},
    "Drill":     {"tempo": (138, 146), "drums": "drill",    "hat_div": 4, "bass": "808",     "sevenths": False, "comp": "pad"},
    "House":     {"tempo": (120, 126), "drums": "four",     "hat_div": 2, "bass": "offbeat", "sevenths": True,  "comp": "stab"},
    "Folk":      {"tempo": (84, 108),  "drums": "brush",    "hat_div": 2, "bass": "root",    "sevenths": False, "comp": "strum"},
    "Ambient":   {"tempo": (60, 80),   "drums": "sparse",   "hat_div": 2, "bass": "sustain", "sevenths": True,  "comp": "pad"},
    "Jazz":      {"tempo": (100, 140), "drums": "brush",    "hat_div": 2, "bass": "walking", "sevenths": True,  "comp": "lazy"},
}
DEFAULT_GENRE = "Lo-fi"

FEELS = ("Half-time", "Driving", "Laid back", "Sparse", "Anthemic", "Hypnotic")

# Scale-degree progressions (0 = tonic). Verse and chorus pick different ones.
PROGRESSIONS = {
    "minor": [[0, 5, 2, 6], [0, 3, 5, 4], [0, 5, 3, 4], [0, 6, 5, 6], [0, 3, 0, 4]],
    "major": [[0, 4, 5, 3], [0, 5, 3, 4], [5, 3, 0, 4], [0, 3, 4, 3], [0, 3, 5, 4]],
}

_GENRE_WORDS = {
    "lo-fi": "Lo-fi", "lofi": "Lo-fi", "lo fi": "Lo-fi", "trap": "Trap", "indie": "Indie rock",
    "rock": "Indie rock", "synthwave": "Synthwave", "retrowave": "Synthwave", "r&b": "R&B",
    "rnb": "R&B", "drill": "Drill", "house": "House", "folk": "Folk", "acoustic": "Folk",
    "ambient": "Ambient", "jazz": "Jazz",
}
_MINOR_MOODS = {"sad", "dark", "moody", "melancholy", "melancholic", "gloomy", "haunting", "eerie", "somber",
                "sombre", "lonely", "heartbreak", "heartbroken", "brooding", "tense", "sinister", "night", "rainy"}
_MAJOR_MOODS = {"happy", "bright", "uplifting", "sunny", "joyful", "cheerful", "summer", "hopeful", "feelgood",
                "euphoric", "upbeat", "celebration", "sunshine"}

_FEEL_WORDS = {
    "half-time": "Half-time", "half time": "Half-time", "halftime": "Half-time", "driving": "Driving",
    "laid back": "Laid back", "laid-back": "Laid back", "chill": "Laid back", "sparse": "Sparse",
    "minimal": "Sparse", "anthemic": "Anthemic", "big": "Anthemic", "hypnotic": "Hypnotic",
}


# ─── Keys and chords ─────────────────────────────────────────────────────────

def normalize_root(name: str) -> Optional[str]:
    if not name:
        return None
    name = name[0].upper() + name[1:]
    name = FLAT_TO_SHARP.get(name, name)
    return name if name in NOTE_NAMES else None


def parse_key(key: str) -> Optional[dict]:
    """'C# minor', 'Db major', 'Am', 'F#m', 'E' -> {'root': 1, 'mode': 'minor', 'name': 'C# minor'}."""
    if not isinstance(key, str):
        return None
    m = re.fullmatch(r"\s*([A-Ga-g][#b]?)\s*(major|minor|maj|min|m)?\s*", key)
    if not m:
        return None
    root = normalize_root(m.group(1))
    if root is None:
        return None
    q = (m.group(2) or "").lower()
    mode = "minor" if q in ("minor", "min", "m") else "major"
    pc = NOTE_NAMES.index(root)
    flats = pc in (FLAT_MINOR if mode == "minor" else FLAT_MAJOR)
    return {"root": pc, "mode": mode, "flats": flats, "name": f"{spell(pc, flats)} {mode}"}


def spell(pc: int, flats: bool) -> str:
    return (FLAT_NAMES if flats else NOTE_NAMES)[pc % 12]


def scale_of(key: dict) -> List[int]:
    base = MINOR_SCALE if key["mode"] == "minor" else MAJOR_SCALE
    return [(key["root"] + s) % 12 for s in base]


_CHORD_RE = re.compile(r"([A-G][#b]?)(maj7|m7b5|m7|dim|m|7)?")
_CHORD_INTERVALS = {
    "": [0, 4, 7], "m": [0, 3, 7], "dim": [0, 3, 6],
    "7": [0, 4, 7, 10], "maj7": [0, 4, 7, 11], "m7": [0, 3, 7, 10], "m7b5": [0, 3, 6, 10],
}


def parse_chord(name: str) -> Optional[dict]:
    """'F#m7' -> {'root': 6, 'intervals': [0, 3, 7, 10], 'quality': 'm7'}."""
    if not isinstance(name, str):
        return None
    m = _CHORD_RE.fullmatch(name.strip())
    if not m:
        return None
    root = normalize_root(m.group(1))
    if root is None:
        return None
    q = m.group(2) or ""
    return {"root": NOTE_NAMES.index(root), "intervals": _CHORD_INTERVALS[q], "quality": q}


def diatonic_chord(key: dict, degree: int, sevenths: bool) -> str:
    sc = scale_of(key)
    root = sc[degree % 7]
    tones = [(sc[(degree + k) % 7] - root) % 12 for k in (0, 2, 4, 6)]
    third, fifth, seventh = tones[1], tones[2], tones[3]
    if third == 4:
        q = ("maj7" if seventh == 11 else "7") if sevenths else ""
    elif fifth == 6:
        q = "m7b5" if sevenths else "dim"
    else:
        q = "m7" if sevenths else "m"
    return spell(root, key["flats"]) + q


def diatonic_chords(key: dict, sevenths: bool = False) -> List[str]:
    return [diatonic_chord(key, d, sevenths) for d in range(7)]


# ─── Prompt reading ──────────────────────────────────────────────────────────

def read_prompt(prompt: str) -> dict:
    """Pull tempo, key, genre and feel out of a free-text description.

    Only what is actually stated is returned; missing fields are None.
    """
    text = (prompt or "").lower()
    out = {"tempo": None, "key": None, "genre": None, "feel": None, "mode": None}

    m = re.search(r"(\d{2,3})\s*(?:bpm|beats per minute)", text)
    if m and 40 <= int(m.group(1)) <= 240:
        out["tempo"] = int(m.group(1))

    def key_from(root, mode):
        root = root.replace(" ", "").replace("sharp", "#").replace("flat", "b")
        k = parse_key(root + " " + (mode or "major"))
        return k["name"] if k else None

    # "in F# minor", "in Bb", "in c sharp minor"
    m = re.search(r"\bin\s+([a-g](?:#|b|\s?sharp|\s?flat)?)\s*(major|minor|maj|min|m)?\b", text)
    if m:
        out["key"] = key_from(m.group(1), m.group(2))
    # "Bb minor", "c sharp major" anywhere
    if out["key"] is None:
        m = re.search(r"(?<![a-z])([a-g](?:#|b|\s?sharp|\s?flat)?)\s*(major|minor)\b", text)
        if m and m.group(1) != "a":  # "a major hit" is an article, not A major
            out["key"] = key_from(m.group(1), m.group(2))
    # Chord-style "F#m", "Ebm", "Am" (case-sensitive, so the word "am" doesn't count)
    if out["key"] is None:
        m = re.search(r"(?<![A-Za-z])([A-G][#b]?)m(?![A-Za-z])", prompt or "")
        if m and not (m.start() == 0 and m.group(1) == "A"):
            out["key"] = key_from(m.group(1), "minor")

    for word, genre in _GENRE_WORDS.items():
        if re.search(r"(?<![a-z])" + re.escape(word) + r"(?![a-z])", text):
            out["genre"] = genre
            break
    for word, feel in _FEEL_WORDS.items():
        if re.search(r"(?<![a-z])" + re.escape(word) + r"(?![a-z])", text):
            out["feel"] = feel
            break
    if out["genre"] is None and any(w in text for w in ("sad", "moody", "dark", "night")):
        out["genre"] = DEFAULT_GENRE
    # Mood picks major or minor when no key was named
    if out["key"] is None:
        words = set(re.findall(r"[a-z]+", text))
        if words & _MINOR_MOODS:
            out["mode"] = "minor"
        elif words & _MAJOR_MOODS:
            out["mode"] = "major"
    return out


# ─── Song plan ───────────────────────────────────────────────────────────────

def plan_song(key: dict, genre: str, feel: Optional[str], rng: random.Random,
              chords: Optional[List[str]] = None) -> List[dict]:
    """Section list with a chord cycle each. `chords` pins every section to that cycle."""
    prof = GENRES[genre]
    progs = PROGRESSIONS[key["mode"]]
    verse_deg = rng.choice(progs)
    chorus_deg = verse_deg if feel == "Hypnotic" else rng.choice([p for p in progs if p != verse_deg])
    verse = chords or [diatonic_chord(key, d, prof["sevenths"]) for d in verse_deg]
    chorus = chords or [diatonic_chord(key, d, prof["sevenths"]) for d in chorus_deg]
    long = 16 if genre == "Ambient" else 8
    layout = [("Intro", 4, verse), ("Verse", long, verse), ("Chorus", 8, chorus),
              ("Verse", long, verse), ("Chorus", 8, chorus), ("Outro", 4, [verse[0], chorus[-1]] if not chords else chords)]
    return [{"id": f"s{i + 1}", "kind": k, "bars": b, "chords": list(c)} for i, (k, b, c) in enumerate(layout)]


def bar_map(sections: List[dict]) -> List[dict]:
    """One entry per bar: the section it belongs to, its index inside it, and its chord."""
    out = []
    for sec in sections:
        cyc = sec["chords"] or ["C"]
        for i in range(sec["bars"]):
            out.append({"sec": sec, "idx": i, "chord": cyc[i % len(cyc)]})
    return out


# ─── Track writers ───────────────────────────────────────────────────────────

def _n(p, t, d, v, **extra):
    note = {"p": int(p), "t": round(max(0.0, t), 4), "d": round(max(0.05, d), 4), "v": int(max(1, min(127, round(v))))}
    note.update(extra)
    return note


def _jit(rng: random.Random, t: float, amt: float) -> float:
    """Humanize timing. Notes on a bar line only ever land late, so no note
    slips back into the previous bar (and section)."""
    if not amt:
        return t
    j = rng.uniform(-amt, amt)
    return t + (abs(j) if t % BEATS_PER_BAR == 0 else j)


def normalize_groove(groove: Optional[List[float]]) -> Optional[List[float]]:
    """Kick positions inside one bar, snapped to 16ths, always including the downbeat."""
    if not groove:
        return None
    steps = sorted({round(float(x) * 4) / 4 for x in groove if 0 <= float(x) < BEATS_PER_BAR})
    if 0.0 not in steps:
        steps.insert(0, 0.0)
    return steps[:8]


def write_drums(sections, genre, feel, rng, fills=True, groove=None) -> List[dict]:
    prof = GENRES[genre]
    style = prof["drums"]
    half = feel == "Half-time" or style in ("halftime", "trap", "drill")
    loose = 0.02 if feel == "Laid back" else 0.01
    hat_div = 4 if feel == "Driving" and prof["hat_div"] == 2 else prof["hat_div"]
    if feel == "Sparse" or style == "sparse":
        hat_div = 2
    kicks = {
        "boombap": [0, 1.5, 2.5], "trap": [0, 1.75, 2.5], "drill": [0, 1.5, 3.25], "rock": [0, 2, 2.5],
        "backbeat": [0, 2], "four": [0, 1, 2, 3], "halftime": [0, 2.75], "brush": [0, 2], "sparse": [0],
    }[style]
    # A riff's strum accents replace the style's kick pattern, so the kick
    # plays with the player instead of against them
    if groove:
        kicks = groove
    out = []
    for bar, b in enumerate(bar_map(sections)):
        o = bar * BEATS_PER_BAR
        kind = b["sec"]["kind"]
        quiet = kind in ("Intro", "Outro")
        big = kind == "Chorus"
        last = b["idx"] == b["sec"]["bars"] - 1
        fill = fills and last and b["sec"]["bars"] >= 4 and not quiet

        for x in (kicks[:1] if quiet else kicks):
            if fill and x >= 3:
                continue
            out.append(_n(KICK, _jit(rng, o + x, loose), 0.2, rng.uniform(100, 122)))
        if big and feel == "Driving" and style != "four":
            out.append(_n(KICK, o + 3.5, 0.2, 96))

        if not quiet:
            snare_beats = [2] if half else [1, 3]
            voice = CLAP if big and style in ("trap", "four", "backbeat", "halftime") else SNARE
            for x in snare_beats:
                if fill and x >= 3:
                    continue
                out.append(_n(voice, _jit(rng, o + x, loose), 0.2, rng.uniform(94, 116)))
            if style == "drill":
                out.append(_n(SNARE, o + 3.75, 0.12, 70))

        if style != "sparse" or not quiet:
            div = 2 if quiet else hat_div
            for i in range(BEATS_PER_BAR * div):
                t = o + i / div
                if fill and t >= o + 3:
                    break
                if feel == "Sparse" and i % 2:
                    continue
                if style == "four" and i % div == div // 2:
                    out.append(_n(OHAT, _jit(rng, t, loose), 0.2, rng.uniform(62, 78)))
                    continue
                accent = i % div == 0
                out.append(_n(CHAT, _jit(rng, t, loose * 0.8), 0.08,
                              rng.uniform(58, 72) if accent else rng.uniform(34, 50)))
            if style in ("trap", "drill") and not quiet and b["idx"] % 4 == 3 and not fill:
                for k in range(3):
                    out.append(_n(CHAT, o + 3.5 + k / 6, 0.05, 44 + k * 8))
            if style in ("trap", "drill", "boombap") and big:
                out.append(_n(PERC, o + 3.5, 0.1, 60))

        if fill:
            for k, x in enumerate((3, 3.25, 3.5, 3.75)):
                out.append(_n(SNARE, o + x, 0.12, 70 + k * 12))
    return out


def _chord_pcs(name: str) -> List[int]:
    c = parse_chord(name) or parse_chord("C")
    return [(c["root"] + i) % 12 for i in c["intervals"]]


def _bass_pitch(pc: int, lo: int = 28) -> int:
    p = lo + ((pc - lo) % 12)
    return p


def write_bass(sections, genre, feel, rng, groove=None) -> List[dict]:
    prof = GENRES[genre]
    style = prof["bass"]
    out = []
    bars = bar_map(sections)
    for bar, b in enumerate(bars):
        o = bar * BEATS_PER_BAR
        kind = b["sec"]["kind"]
        c = parse_chord(b["chord"]) or parse_chord("C")
        root = _bass_pitch(c["root"])
        fifth = root + 7
        big = kind == "Chorus"
        if kind == "Intro":
            out.append(_n(root, o, 3.8, 84))
            continue
        if style == "sustain" or feel == "Sparse":
            out.append(_n(root, o, 3.8, 90))
        elif groove and style not in ("walking", "offbeat", "pulse"):
            # Lock to the riff: one note per kick, held until the next one
            for i, x in enumerate(groove):
                nxt = groove[i + 1] if i + 1 < len(groove) else BEATS_PER_BAR
                p = fifth if (big and i == len(groove) - 1 and len(groove) > 2) else root
                out.append(_n(p, _jit(rng, o + x, 0.01), max(0.2, (nxt - x) * 0.9), rng.uniform(96, 112) if x == 0 else rng.uniform(84, 98)))
        elif style == "808":
            out.append(_n(root, _jit(rng, o, 0.01), 1.4 if big else 2.2, rng.uniform(108, 124)))
            out.append(_n(root, o + 2.5, 0.9, rng.uniform(88, 100)))
            if big and b["idx"] % 2 == 1:
                out.append(_n(root + 12, o + 3.5, 0.45, 92, glide=True))
        elif style == "pulse":
            for i in range(8):
                out.append(_n(root if i % 4 != 3 else fifth, o + i * 0.5, 0.42, 96 if i % 2 == 0 else 80))
        elif style == "offbeat":
            for i in range(4):
                out.append(_n(root, o + i + 0.5, 0.4, 100))
        elif style == "walking":
            nxt = parse_chord(bars[bar + 1]["chord"]) if bar + 1 < len(bars) else c
            target = _bass_pitch(nxt["root"])
            third = root + c["intervals"][1]
            approach = target - 1 if target > root else target + 1
            for i, p in enumerate((root, third, fifth, approach)):
                out.append(_n(p, _jit(rng, o + i, 0.01), 0.9, rng.uniform(84, 98)))
        elif style == "round":
            out.append(_n(root, _jit(rng, o, 0.015), 1.5, rng.uniform(96, 110)))
            out.append(_n(root, o + 1.75, 0.6, 78))
            out.append(_n(fifth if big else root, o + 2.5, 1.2, 88))
        else:  # root
            out.append(_n(root, o, 1.4, 104))
            out.append(_n(root, o + 2, 0.9, 92))
            out.append(_n(fifth, o + 3, 0.45, 84))
            out.append(_n(root, o + 3.5, 0.45, 84))
    return out


def _voice(pcs: List[int], prev_center: float, lo: int = 55, hi: int = 76) -> List[int]:
    """Pick the inversion whose centre sits nearest the previous chord (smooth voice leading)."""
    best, best_d = None, 1e9
    for inv in range(len(pcs)):
        order = pcs[inv:] + pcs[:inv]
        for base in range(lo, hi):
            if base % 12 != order[0]:
                continue
            notes = [base]
            for pc in order[1:]:
                p = notes[-1] + 1
                while p % 12 != pc:
                    p += 1
                notes.append(p)
            if notes[-1] > hi:
                continue
            d = abs(sum(notes) / len(notes) - prev_center)
            if d < best_d:
                best, best_d = notes, d
    return best or [60 + pc for pc in pcs]


def write_chords(sections, genre, feel, rng) -> List[dict]:
    comp = GENRES[genre]["comp"]
    out = []
    center = 64.0
    for bar, b in enumerate(bar_map(sections)):
        o = bar * BEATS_PER_BAR
        kind = b["sec"]["kind"]
        voicing = _voice(_chord_pcs(b["chord"]), center)
        center = sum(voicing) / len(voicing)
        big = kind == "Chorus"
        base_v = 74 if big else 62
        if feel == "Sparse" or kind in ("Intro", "Outro") or comp == "pad":
            hits = [(0, 3.8)]
        elif comp == "lazy":
            hits = [(0, 1.4), (2.5, 1.3)]
        elif comp == "stab":
            hits = [(0.5, 0.35), (1.5, 0.35), (2.5, 0.35), (3.5, 0.35)]
        else:  # strum
            hits = [(0, 0.9), (1, 0.45), (1.5, 0.9), (2.5, 0.45), (3, 0.9)]
        for x, d in hits:
            t0 = _jit(rng, o + x, 0.01)
            for k, p in enumerate(voicing):
                out.append(_n(p, t0 + k * 0.012, d, rng.uniform(base_v - 6, base_v + 6)))
        if big and feel == "Anthemic":
            out.append(_n(voicing[-1] + 12, o, 3.8, base_v - 8))
    return out


_MOTIFS = {
    "Verse":  [[(1, 1.5), (3, 0.5), (3.5, 1.0), (5, 2.5)], [(0.5, 0.5), (1, 1), (2.5, 1.5), (5, 1), (6, 1.5)]],
    "Chorus": [[(0, 1.5), (1.5, 0.5), (2, 1), (3, 1), (4, 1.5), (5.5, 0.5), (6, 2)],
               [(0, 1), (1, 1), (2, 1.5), (4, 1), (5, 1), (6, 2)]],
    "Bridge": [[(0, 3), (4, 3)]],
}


def write_melody(sections, key, genre, feel, rng) -> List[dict]:
    sc = scale_of(key)
    out = []
    bars = bar_map(sections)
    prev = 72
    start_bar = 0
    for sec in sections:
        motifs = _MOTIFS.get(sec["kind"])
        if motifs is None or (feel == "Sparse" and sec["kind"] == "Verse"):
            start_bar += sec["bars"]
            continue
        motif = rng.choice(motifs)
        for pair in range(0, sec["bars"], 2):
            o = (start_bar + pair) * BEATS_PER_BAR
            for i, (x, d) in enumerate(motif):
                bar = start_bar + pair + int(x // BEATS_PER_BAR)
                if bar >= start_bar + sec["bars"]:
                    break
                pcs = _chord_pcs(bars[bar]["chord"])
                strong = x % 1 == 0 and int(x) % 2 == 0
                if strong or i == len(motif) - 1:
                    cands = [p for p in range(64, 86) if p % 12 in pcs]
                else:
                    cands = [p for p in range(64, 86) if p % 12 in sc and 0 < abs(p - prev) <= 4]
                cands = cands or [p for p in range(64, 86) if p % 12 in pcs]
                weights = [1.0 / (1 + abs(p - prev)) for p in cands]
                p = rng.choices(cands, weights=weights)[0]
                prev = p
                vel = rng.uniform(80, 96) if sec["kind"] == "Chorus" else rng.uniform(70, 86)
                out.append(_n(p, _jit(rng, o + x, 0.015), d * 0.95, vel))
        start_bar += sec["bars"]
    return out


TRACK_META = {
    "drums":  {"name": "Drums",      "sound": "Tight kit"},
    "bass":   {"name": "808 / Bass", "sound": "Warm bass"},
    "chords": {"name": "Chords",     "sound": "Felt piano"},
    "melody": {"name": "Melody",     "sound": "Soft pad"},
}


def write_track(track_id, sections, key, genre, feel, seed, fills=True, groove=None) -> List[dict]:
    rng = random.Random(f"{seed}:{track_id}")
    if track_id == "drums":
        notes = write_drums(sections, genre, feel, rng, fills, groove)
    elif track_id == "bass":
        notes = write_bass(sections, genre, feel, rng, groove)
    elif track_id == "chords":
        notes = write_chords(sections, genre, feel, rng)
    elif track_id == "melody":
        notes = write_melody(sections, key, genre, feel, rng)
    else:
        raise ValueError(f"unknown track {track_id!r}")
    notes.sort(key=lambda n: (n["t"], n["p"]))
    return notes


def compose(genre: Optional[str], feel: Optional[str], tempo: Optional[int], key: Optional[str],
            seed: int, chords: Optional[List[str]] = None, fills: bool = True,
            groove: Optional[List[float]] = None, mode: Optional[str] = None) -> dict:
    """Write a whole project. Unspecified tempo/key are chosen from the genre, seeded."""
    genre = genre if genre in GENRES else DEFAULT_GENRE
    feel = feel if feel in FEELS else None
    rng = random.Random(seed)
    lo, hi = GENRES[genre]["tempo"]
    tempo = int(tempo) if tempo else rng.randint(lo, hi)
    k = parse_key(key) if key else None
    if k is None:
        pick = rng.random()
        mode = mode if mode in ("major", "minor") else ("minor" if pick < 0.7 else "major")
        k = parse_key(f"{rng.choice(NOTE_NAMES)} {mode}")
    if chords:
        chords = [spell(parse_chord(c)["root"], k["flats"]) + parse_chord(c)["quality"] for c in chords]
    sections = plan_song(k, genre, feel, rng, chords)
    groove = normalize_groove(groove)
    tracks = []
    for tid in TRACK_IDS:
        meta = TRACK_META[tid]
        tracks.append({"id": tid, "name": meta["name"], "kind": "midi", "sound": meta["sound"],
                       "notes": write_track(tid, sections, k, genre, feel, seed, fills, groove)})
    return {
        "tempo": tempo, "key": k["name"], "time_signature": "4/4", "genre": genre, "feel": feel,
        "seed": seed, "groove": groove, "sections": sections, "tracks": tracks,
    }
