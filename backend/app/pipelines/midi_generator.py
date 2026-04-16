"""MIDI generation pipeline — mock (genre-aware) + vLLM + Replicate fallback."""

import os
import pretty_midi
import numpy as np
from pathlib import Path
from typing import Optional

VLLM_URL = os.environ.get('VLLM_URL', 'http://localhost:8000')

KEY_ROOTS = {
    'C': 60, 'Cm': 60, 'C#': 61, 'C#m': 61,
    'D': 62, 'Dm': 62, 'Eb': 63, 'Ebm': 63,
    'E': 64, 'Em': 64, 'F': 65, 'Fm': 65,
    'F#': 66, 'F#m': 66, 'G': 67, 'Gm': 67,
    'Ab': 68, 'Abm': 68, 'A': 69, 'Am': 69,
    'Bb': 70, 'Bbm': 70, 'B': 71, 'Bm': 71,
}

MINOR_KEYS = {'Cm','C#m','Dm','Ebm','Em','Fm','F#m','Gm','Abm','Am','Bbm','Bm'}


def _is_minor(key: str) -> bool:
    return key in MINOR_KEYS or key.endswith('m')


def _scale(root: int, minor: bool) -> list:
    intervals = [0,2,3,5,7,8,10] if minor else [0,2,4,5,7,9,11]
    return [root + i for i in intervals]


def _pentatonic(root: int, minor: bool) -> list:
    intervals = [0,3,5,7,10] if minor else [0,2,4,7,9]
    return [root + i for i in intervals]


def _chord_roots(root: int, minor: bool) -> list:
    """4-chord progression roots."""
    if minor:
        # i - VI - III - VII
        return [root, root-3, root+3, root-2]
    else:
        # I - V - vi - IV
        return [root, root+7, root-3, root+5]


def _chord_notes(chord_root: int, minor: bool) -> list:
    triad = [0,3,7] if minor else [0,4,7]
    return [chord_root + i for i in triad]


def mock_generate(genre: str, tempo: int, key: str, num_bars: int = 32) -> pretty_midi.PrettyMIDI:
    """Generate a musically coherent, genre-aware multi-track MIDI."""
    g = genre.lower().replace(' ', '-').replace('_', '-')
    minor = _is_minor(key)
    root = KEY_ROOTS.get(key, 69)

    beat = 60.0 / tempo
    bar = beat * 4
    progression = _chord_roots(root, minor)
    pent = _pentatonic(root, minor)

    pm = pretty_midi.PrettyMIDI(initial_tempo=tempo, resolution=480)

    # ── EDM ──────────────────────────────────────────────────────────────────
    if g in ('edm', 'house', 'techno'):
        # Structure: 4 bars drums → +4 bass → +4 chords → 20 bars full
        _edm_drums(pm, tempo, bar, beat, num_bars)
        _edm_bass(pm, bar, beat, num_bars, progression, minor)
        _edm_chords(pm, bar, beat, num_bars, progression, minor)
        _edm_melody(pm, bar, beat, num_bars, pent, root, minor)

    # ── TRAP ─────────────────────────────────────────────────────────────────
    elif g == 'trap':
        _trap_drums(pm, tempo, bar, beat, num_bars)
        _trap_bass(pm, bar, beat, num_bars, progression)
        _trap_chords(pm, bar, beat, num_bars, progression, minor)
        _trap_melody(pm, bar, beat, num_bars, root, minor)

    # ── LO-FI HIP HOP ────────────────────────────────────────────────────────
    elif g in ('lo-fi-hip-hop', 'lo-fi', 'lofi', 'hip-hop'):
        _lofi_drums(pm, tempo, bar, beat, num_bars)
        _lofi_bass(pm, bar, beat, num_bars, progression)
        _lofi_chords(pm, bar, beat, num_bars, progression, minor)
        _lofi_melody(pm, bar, beat, num_bars, pent, root, minor)

    # ── SYNTHWAVE ─────────────────────────────────────────────────────────────
    elif g == 'synthwave':
        _synthwave_drums(pm, tempo, bar, beat, num_bars)
        _synthwave_bass(pm, bar, beat, num_bars, progression)
        _synthwave_chords(pm, bar, beat, num_bars, progression, minor)
        _synthwave_melody(pm, bar, beat, num_bars, pent, root, minor)

    # ── JAZZ ─────────────────────────────────────────────────────────────────
    elif g == 'jazz':
        _jazz_drums(pm, tempo, bar, beat, num_bars)
        _jazz_bass(pm, bar, beat, num_bars, progression)
        _jazz_chords(pm, bar, beat, num_bars, progression, minor)
        _jazz_melody(pm, bar, beat, num_bars, root, minor)

    # ── AMBIENT ──────────────────────────────────────────────────────────────
    elif g == 'ambient':
        _ambient_pads(pm, bar, beat, num_bars, progression, minor)
        _ambient_melody(pm, bar, beat, num_bars, pent, root)

    # ── DEFAULT (pop/rock/generic) ────────────────────────────────────────────
    else:
        _generic_drums(pm, tempo, bar, beat, num_bars)
        _generic_bass(pm, bar, beat, num_bars, progression)
        _generic_chords(pm, bar, beat, num_bars, progression, minor)
        _generic_melody(pm, bar, beat, num_bars, pent, root, minor)

    return pm


# ─── EDM ─────────────────────────────────────────────────────────────────────

def _edm_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, CLAP, CHAT, OHAT, CRASH = 36, 38, 39, 42, 46, 49
    for b in range(num_bars):
        t = b * bar
        if b == 0 or b == 8 or b == 16:
            inst.notes.append(pretty_midi.Note(100, CRASH, t, t + 0.1))
        for beat_i in range(4):
            bt = t + beat_i * beat
            # Four-on-floor kick (skip first 4 bars)
            if b >= 4:
                inst.notes.append(pretty_midi.Note(100, KICK, bt, bt + 0.08))
            # Snare/clap on 2+4 (skip first 8 bars)
            if b >= 8 and beat_i in (1, 3):
                inst.notes.append(pretty_midi.Note(90, CLAP, bt, bt + 0.05))
            # Closed hats every 8th
            for e in range(2):
                hat_t = bt + e * beat * 0.5
                if b >= 4:
                    inst.notes.append(pretty_midi.Note(65 if e else 75, CHAT, hat_t, hat_t + 0.04))
            # Open hat on offbeat 8th (beat 2 and 4 offbeats)
            if b >= 12 and beat_i in (1, 3):
                oht = bt + beat * 0.5
                inst.notes.append(pretty_midi.Note(70, OHAT, oht, oht + 0.04))
    pm.instruments.append(inst)


def _edm_bass(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=38, name='Bass')  # synth bass
    for b in range(8, num_bars):  # start at bar 8
        chord_root = progression[b % 4] - 24
        while chord_root < 28: chord_root += 12
        t = b * bar
        for beat_i in range(4):
            bt = t + beat_i * beat
            # Short sidechain-style note on every beat
            inst.notes.append(pretty_midi.Note(95, chord_root, bt, bt + beat * 0.35))
            # Octave jump on offbeat
            inst.notes.append(pretty_midi.Note(75, chord_root + 12, bt + beat * 0.5, bt + beat * 0.75))
    pm.instruments.append(inst)


def _edm_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=89, name='Chords')  # pad
    for b in range(12, num_bars):  # start at bar 12
        cr = progression[b % 4]
        notes = _chord_notes(cr, minor)
        notes = [(n % 12) + 60 for n in notes]
        t = b * bar
        # Arpeggio: 16th notes up through chord tones x2
        arp = notes * 2
        for i, pitch in enumerate(arp):
            nt = t + i * beat * 0.25
            if nt < t + bar:
                inst.notes.append(pretty_midi.Note(72, pitch, nt, nt + beat * 0.2))
    pm.instruments.append(inst)


def _edm_melody(pm, bar, beat, num_bars, pent, root, minor):
    inst = pretty_midi.Instrument(program=80, name='Melody')  # lead synth
    for b in range(16, num_bars):  # enters at bar 16
        cr = root
        lpent = [(cr + i) % 12 + 60 for i in ([0,3,5,7,10] if minor else [0,2,4,7,9])]
        t = b * bar
        for e in range(8):  # 8th notes
            if np.random.random() < 0.6:
                nt = t + e * beat * 0.5
                dur = beat * np.random.choice([0.5, 0.5, 1.0])
                dur = min(dur, bar - e * beat * 0.5 - 0.01)
                pitch = np.random.choice(lpent)
                while pitch < 64: pitch += 12
                while pitch > 88: pitch -= 12
                inst.notes.append(pretty_midi.Note(np.random.randint(75, 100), pitch, nt, nt + dur))
    pm.instruments.append(inst)


# ─── TRAP ─────────────────────────────────────────────────────────────────────

def _trap_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, CHAT, OHAT = 36, 38, 42, 46
    for b in range(num_bars):
        t = b * bar
        # Sparse kick: beat 1, sometimes beat 2.5 or 3.5
        inst.notes.append(pretty_midi.Note(100, KICK, t, t + 0.08))
        if np.random.random() < 0.5:
            kt = t + beat * 2.5
            inst.notes.append(pretty_midi.Note(90, KICK, kt, kt + 0.08))
        # Snare/clap on beat 3
        st = t + beat * 2
        inst.notes.append(pretty_midi.Note(95, SNARE, st, st + 0.05))
        # Hi-hat rolls: 16th and 32nd note patterns with velocity ramps
        for sixteenth in range(16):
            ht = t + sixteenth * beat * 0.25
            # Triplet feel: groups of 3
            vel = 40 + (sixteenth % 4) * 15
            if np.random.random() < 0.7:
                inst.notes.append(pretty_midi.Note(vel, CHAT, ht, ht + 0.03))
            # Occasional 32nd note flourish
            if sixteenth % 4 == 3 and np.random.random() < 0.4:
                ht2 = ht + beat * 0.125
                inst.notes.append(pretty_midi.Note(55, CHAT, ht2, ht2 + 0.02))
        # Open hat
        if np.random.random() < 0.3:
            ot = t + beat * 1.5
            inst.notes.append(pretty_midi.Note(70, OHAT, ot, ot + 0.05))
    pm.instruments.append(inst)


def _trap_bass(pm, bar, beat, num_bars, progression):
    inst = pretty_midi.Instrument(program=38, name='Bass')  # 808 bass
    for b in range(num_bars):
        root = progression[b % 4] - 24
        while root < 24: root += 12
        t = b * bar
        # Long sustain 808 note
        inst.notes.append(pretty_midi.Note(95, root, t, t + bar * 0.9))
        # Occasional sub movement
        if np.random.random() < 0.4:
            slide_t = t + bar * 0.5
            root2 = progression[(b + 1) % 4] - 24
            while root2 < 24: root2 += 12
            inst.notes.append(pretty_midi.Note(85, root2, slide_t, t + bar * 0.95))
    pm.instruments.append(inst)


def _trap_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=89, name='Chords')  # dark pad
    for b in range(num_bars):
        cr = progression[b % 4]
        notes = _chord_notes(cr, minor)
        notes = [(n % 12) + 60 for n in notes]
        t = b * bar
        for p in notes:
            inst.notes.append(pretty_midi.Note(55, p, t, t + bar - 0.1))
    pm.instruments.append(inst)


def _trap_melody(pm, bar, beat, num_bars, root, minor):
    inst = pretty_midi.Instrument(program=0, name='Melody')
    scale = _scale(root, minor)
    for b in range(num_bars):
        t = b * bar
        if np.random.random() < 0.65:  # sparse
            for _ in range(np.random.randint(2, 5)):
                st = t + np.random.random() * bar * 0.8
                pitch = np.random.choice(scale) % 12 + 60
                while pitch < 60: pitch += 12
                while pitch > 82: pitch -= 12
                dur = beat * np.random.choice([0.25, 0.5, 0.25])
                inst.notes.append(pretty_midi.Note(np.random.randint(55, 80), pitch, st, st + dur))
    pm.instruments.append(inst)


# ─── LO-FI HIP HOP ───────────────────────────────────────────────────────────

def _lofi_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, CHAT = 35, 38, 42
    swing = beat * 0.08  # swing offset
    for b in range(num_bars):
        t = b * bar
        # Boom-bap kick: beat 1, sometimes "and" of 2 or 3
        inst.notes.append(pretty_midi.Note(90, KICK, t, t + 0.08))
        if np.random.random() < 0.4:
            inst.notes.append(pretty_midi.Note(80, KICK, t + beat * 1.5, t + beat * 1.58))
        if np.random.random() < 0.3:
            inst.notes.append(pretty_midi.Note(75, KICK, t + beat * 2.5, t + beat * 2.58))
        # Snare on 2 and 4
        inst.notes.append(pretty_midi.Note(85, SNARE, t + beat, t + beat + 0.06))
        inst.notes.append(pretty_midi.Note(80, SNARE, t + beat * 3, t + beat * 3 + 0.06))
        # Swung hi-hats with velocity variation
        for e in range(8):
            ht = t + e * beat * 0.5 + (swing if e % 2 == 1 else 0)
            vel = np.random.randint(45, 75)
            inst.notes.append(pretty_midi.Note(vel, CHAT, ht, ht + 0.04))
    pm.instruments.append(inst)


def _lofi_bass(pm, bar, beat, num_bars, progression):
    inst = pretty_midi.Instrument(program=33, name='Bass')
    for b in range(num_bars):
        root = progression[b % 4] - 12
        while root < 36: root += 12
        t = b * bar
        # Mellow quarter notes
        for beat_i in range(4):
            pitch = root if beat_i % 2 == 0 else root + 5
            bt = t + beat_i * beat
            inst.notes.append(pretty_midi.Note(70, pitch, bt, bt + beat * 0.8))
    pm.instruments.append(inst)


def _lofi_chords(pm, bar, beat, num_bars, progression, minor):
    # Rhodes-style piano, jazzy voicings (add 9ths)
    inst = pretty_midi.Instrument(program=4, name='Chords')  # Rhodes
    for b in range(num_bars):
        cr = progression[b % 4]
        # 7th chord voicing
        if minor:
            chord = [cr, cr+3, cr+7, cr+10]  # min7
        else:
            chord = [cr, cr+4, cr+7, cr+11]  # maj7
        chord = [(p % 12) + 60 for p in chord]
        t = b * bar
        # Half-note duration, offbeat feel
        for beat_i in (1, 3):
            bt = t + beat_i * beat
            for p in chord:
                vel = np.random.randint(55, 72)
                inst.notes.append(pretty_midi.Note(vel, p, bt, bt + beat * 0.9))
    pm.instruments.append(inst)


def _lofi_melody(pm, bar, beat, num_bars, pent, root, minor):
    inst = pretty_midi.Instrument(program=4, name='Melody')  # piano
    for b in range(num_bars):
        t = b * bar
        num_notes = np.random.randint(2, 5)
        positions = sorted(np.random.uniform(0, bar * 0.85, num_notes))
        for pos in positions:
            pitch = np.random.choice(pent) % 12 + 72
            while pitch > 84: pitch -= 12
            dur = beat * np.random.choice([0.5, 1.0, 1.5])
            vel = np.random.randint(55, 75)
            inst.notes.append(pretty_midi.Note(vel, pitch, t + pos, t + pos + dur))
    pm.instruments.append(inst)


# ─── SYNTHWAVE ────────────────────────────────────────────────────────────────

def _synthwave_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, CHAT, CRASH = 36, 38, 42, 49
    for b in range(num_bars):
        t = b * bar
        if b % 8 == 0:
            inst.notes.append(pretty_midi.Note(95, CRASH, t, t + 0.1))
        for beat_i in range(4):
            bt = t + beat_i * beat
            if beat_i in (0, 2):
                inst.notes.append(pretty_midi.Note(95, KICK, bt, bt + 0.08))
            if beat_i in (1, 3):
                inst.notes.append(pretty_midi.Note(88, SNARE, bt, bt + 0.06))
            for e in range(2):
                ht = bt + e * beat * 0.5
                inst.notes.append(pretty_midi.Note(60 if e else 70, CHAT, ht, ht + 0.04))
    pm.instruments.append(inst)


def _synthwave_bass(pm, bar, beat, num_bars, progression):
    inst = pretty_midi.Instrument(program=38, name='Bass')
    for b in range(num_bars):
        root = progression[b % 4] - 12
        while root < 36: root += 12
        t = b * bar
        for beat_i in range(4):
            bt = t + beat_i * beat
            inst.notes.append(pretty_midi.Note(88, root, bt, bt + beat * 0.45))
    pm.instruments.append(inst)


def _synthwave_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=89, name='Chords')  # synth pad
    for b in range(num_bars):
        cr = progression[b % 4]
        notes = _chord_notes(cr, minor)
        notes = [(n % 12) + 60 for n in notes]
        t = b * bar
        # Sustained pad for 2 bars
        if b % 2 == 0:
            for p in notes:
                inst.notes.append(pretty_midi.Note(65, p, t, t + bar * 2 - 0.05))
    pm.instruments.append(inst)


def _synthwave_melody(pm, bar, beat, num_bars, pent, root, minor):
    inst = pretty_midi.Instrument(program=80, name='Melody')  # lead
    for b in range(num_bars):
        t = b * bar
        # Signature synthwave: 8th note run, then hold
        pitches = [(root + i) % 12 + 72 for i in ([0,3,5,7,10] if minor else [0,2,4,7,9])]
        # First 4 8th notes ascending
        for i in range(4):
            if i < len(pitches):
                nt = t + i * beat * 0.5
                inst.notes.append(pretty_midi.Note(82, pitches[i], nt, nt + beat * 0.45))
        # Hold note for 2 beats
        hold_t = t + beat * 2
        inst.notes.append(pretty_midi.Note(85, pitches[-1], hold_t, hold_t + beat * 2 - 0.05))
    pm.instruments.append(inst)


# ─── JAZZ ─────────────────────────────────────────────────────────────────────

def _jazz_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, RIDE = 36, 38, 51
    for b in range(num_bars):
        t = b * bar
        swing = beat * 0.1
        # Ride pattern: triplet swing feel
        for triplet in range(6):
            rt = t + triplet * beat * (2/3)
            vel = 65 if triplet % 2 == 0 else 50
            inst.notes.append(pretty_midi.Note(vel, RIDE, rt, rt + 0.04))
        # Kick on 1
        inst.notes.append(pretty_midi.Note(80, KICK, t, t + 0.06))
        # Snare comping (ghost notes + accent)
        for beat_i in range(4):
            if np.random.random() < 0.4:
                st = t + beat_i * beat + (swing if beat_i % 2 == 1 else 0)
                vel = np.random.randint(35, 75)
                inst.notes.append(pretty_midi.Note(vel, SNARE, st, st + 0.04))
    pm.instruments.append(inst)


def _jazz_bass(pm, bar, beat, num_bars, progression):
    inst = pretty_midi.Instrument(program=33, name='Bass')
    for b in range(num_bars):
        root = progression[b % 4] - 12
        while root < 36: root += 12
        t = b * bar
        walk = [root, root+2, root+4, root+7]  # walk up
        for beat_i, pitch in enumerate(walk):
            bt = t + beat_i * beat
            inst.notes.append(pretty_midi.Note(80, pitch, bt, bt + beat * 0.9))
    pm.instruments.append(inst)


def _jazz_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=4, name='Chords')  # piano
    for b in range(num_bars):
        cr = progression[b % 4]
        # ii-V-I style voicing with 9ths
        if minor:
            chord = [cr, cr+3, cr+7, cr+10, cr+14]  # min9
        else:
            chord = [cr, cr+4, cr+7, cr+11, cr+14]  # maj9
        chord = [(p % 12) + 60 for p in chord][:4]
        t = b * bar
        # Comping: 2 stabs per bar at random beat positions
        for beat_i in np.random.choice([0,1,2,3], 2, replace=False):
            bt = t + beat_i * beat
            for p in chord:
                inst.notes.append(pretty_midi.Note(np.random.randint(60, 78), p, bt, bt + beat * 0.4))
    pm.instruments.append(inst)


def _jazz_melody(pm, bar, beat, num_bars, root, minor):
    inst = pretty_midi.Instrument(program=66, name='Melody')  # tenor sax
    scale = _scale(root, minor)
    for b in range(num_bars):
        t = b * bar
        num_notes = np.random.randint(3, 7)
        curr_pitch = (root % 12) + 72
        for i in range(num_notes):
            nt = t + i * (bar / num_notes) * np.random.uniform(0.8, 1.1)
            if nt >= t + bar: break
            step = np.random.choice([-2,-1,0,1,2])
            curr_pitch = np.clip(curr_pitch + step, 60, 84)
            dur = beat * np.random.choice([0.5, 1.0, 1.5, 0.25])
            vel = np.random.randint(65, 90)
            inst.notes.append(pretty_midi.Note(vel, curr_pitch, nt, nt + dur))
    pm.instruments.append(inst)


# ─── AMBIENT ─────────────────────────────────────────────────────────────────

def _ambient_pads(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=89, name='Chords')  # pad
    for b in range(0, num_bars, 4):  # change every 4 bars
        cr = progression[(b // 4) % 4]
        if minor:
            chord = [cr-12, cr, cr+7, cr+12, cr+19]
        else:
            chord = [cr-12, cr, cr+7, cr+11, cr+19]
        chord = [(p % 12) + 48 for p in chord]
        t = b * bar
        duration = bar * 4 - 0.1
        for p in chord:
            vel = np.random.randint(45, 65)
            inst.notes.append(pretty_midi.Note(vel, p, t, t + duration))
    pm.instruments.append(inst)


def _ambient_melody(pm, bar, beat, num_bars, pent, root):
    inst = pretty_midi.Instrument(program=99, name='Melody')  # FX
    for b in range(0, num_bars, 2):
        t = b * bar
        if np.random.random() < 0.6:
            pitch = np.random.choice(pent) % 12 + 72
            dur = bar * np.random.uniform(1.5, 3.5)
            vel = np.random.randint(40, 65)
            inst.notes.append(pretty_midi.Note(vel, pitch, t, t + dur))
    pm.instruments.append(inst)


# ─── GENERIC (pop/rock) ───────────────────────────────────────────────────────

def _generic_drums(pm, tempo, bar, beat, num_bars):
    inst = pretty_midi.Instrument(program=0, is_drum=True, name='Drums')
    KICK, SNARE, CHAT, CRASH = 36, 38, 42, 49
    for b in range(num_bars):
        t = b * bar
        if b % 8 == 0:
            inst.notes.append(pretty_midi.Note(90, CRASH, t, t + 0.1))
        for beat_i in range(4):
            bt = t + beat_i * beat
            if beat_i in (0, 2):
                inst.notes.append(pretty_midi.Note(90, KICK, bt, bt + 0.08))
            if beat_i in (1, 3):
                inst.notes.append(pretty_midi.Note(85, SNARE, bt, bt + 0.06))
            for e in range(2):
                ht = bt + e * beat * 0.5
                inst.notes.append(pretty_midi.Note(55 if e else 68, CHAT, ht, ht + 0.04))
    pm.instruments.append(inst)


def _generic_bass(pm, bar, beat, num_bars, progression):
    inst = pretty_midi.Instrument(program=33, name='Bass')
    for b in range(num_bars):
        root = progression[b % 4] - 12
        while root < 36: root += 12
        t = b * bar
        for beat_i in range(4):
            bt = t + beat_i * beat
            inst.notes.append(pretty_midi.Note(85, root, bt, bt + beat * 0.8))
    pm.instruments.append(inst)


def _generic_chords(pm, bar, beat, num_bars, progression, minor):
    inst = pretty_midi.Instrument(program=0, name='Chords')
    for b in range(num_bars):
        cr = progression[b % 4]
        notes = _chord_notes(cr, minor)
        notes = [(n % 12) + 60 for n in notes]
        t = b * bar
        if b % 2 == 0:
            for p in notes:
                inst.notes.append(pretty_midi.Note(68, p, t, t + bar * 2 - 0.1))
    pm.instruments.append(inst)


def _generic_melody(pm, bar, beat, num_bars, pent, root, minor):
    inst = pretty_midi.Instrument(program=0, name='Melody')
    for b in range(num_bars):
        t = b * bar
        for e in range(8):
            if np.random.random() < 0.55:
                nt = t + e * beat * 0.5
                pitch = np.random.choice(pent) % 12 + 72
                while pitch > 84: pitch -= 12
                dur = beat * np.random.choice([0.5, 1.0])
                inst.notes.append(pretty_midi.Note(np.random.randint(70, 90), pitch, nt, nt + dur))
    pm.instruments.append(inst)


# ─── Public API ───────────────────────────────────────────────────────────────

def generate_from_prompt(
    prompt: str,
    output_path: str,
    conditioning_midi: Optional[str] = None,
    genre: str = 'edm',
    tempo: int = 128,
    key: str = 'Am',
    **kwargs,
) -> str:
    provider = os.environ.get('MIDI_GEN_PROVIDER', 'mock')

    if provider == 'mock':
        pm = mock_generate(genre=genre, tempo=tempo, key=key)
        Path(output_path).parent.mkdir(parents=True, exist_ok=True)
        pm.write(output_path)
        return output_path
    elif provider == 'api':
        return _generate_via_replicate(prompt, output_path, conditioning_midi, genre=genre, tempo=tempo, key=key)
    else:
        return _generate_via_vllm(prompt, output_path, conditioning_midi, **kwargs)


def _generate_via_replicate(prompt, output_path, conditioning_midi=None, genre='edm', tempo=128, key='Am'):
    # No text-to-MIDI model on Replicate (as of 2026-04).
    # MIDI-LLM and Text2midi are research-only — not hosted on Replicate.
    print("[midi_generator] No MIDI-LLM on Replicate — using enhanced mock generator.")
    print("[midi_generator] To self-host: see https://github.com/slSeanWU/MIDI-LLM")
    pm = mock_generate(genre=genre, tempo=tempo, key=key)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    pm.write(output_path)
    return output_path


def _generate_via_vllm(prompt, output_path, conditioning_midi=None, max_tokens=4096, temperature=0.9, top_p=0.95):
    import httpx
    SYSTEM_PROMPT = "You are a world-class composer. Please compose some music according to the following description:"
    full_prompt = f"{SYSTEM_PROMPT}\n{prompt}"

    if conditioning_midi and Path(conditioning_midi).exists():
        try:
            tokens = _midi_to_amt_tokens(conditioning_midi)
            full_prompt = f"{full_prompt}\n\nReference melody:\n{tokens}"
        except Exception:
            pass

    response = httpx.post(
        f"{VLLM_URL}/v1/completions",
        json={
            "model": "slseanwu/MIDI-LLM_Llama-3.2-1B",
            "prompt": full_prompt,
            "max_tokens": max_tokens,
            "temperature": temperature,
            "top_p": top_p,
            "stop": ["</s>"],
        },
        timeout=120.0,
    )
    response.raise_for_status()
    generated = response.json()["choices"][0]["text"]
    pm = _amt_tokens_to_midi(generated)
    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
    pm.write(output_path)
    return output_path


def _midi_to_amt_tokens(midi_path):
    pm = pretty_midi.PrettyMIDI(midi_path)
    tokens = []
    for instrument in pm.instruments:
        for note in instrument.notes:
            tokens.append(f"t{int(note.start*1000)} n{note.pitch} d{int((note.end-note.start)*1000)}")
    return " ".join(tokens)


def _amt_tokens_to_midi(token_string):
    pm = pretty_midi.PrettyMIDI()
    instrument = pretty_midi.Instrument(program=0)
    pm.instruments.append(instrument)
    return pm
