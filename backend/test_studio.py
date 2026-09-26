"""
Studio tests: composer ground truth and the /api/studio endpoints.

The composer is rule-based, so its ground truth is music theory: every bass
note on a downbeat is the bar's chord root, every chord note belongs to the
bar's chord, every melody note is in the key, and so on.

The endpoint tests run against an in-memory SQLite database; the tracked
backend/data/voxmidi.db is never opened.

Run from backend/ with:
    .venv/bin/python test_studio.py
"""

import io
import os
import sys
import tempfile
from pathlib import Path

os.environ["DEV_MODE"] = "true"
sys.path.insert(0, str(Path(__file__).parent / "app"))

from pipelines.composer import (  # noqa: E402
    compose, read_prompt, parse_chord, parse_key, scale_of, bar_map, write_track,
    DRUM_PITCHES, KICK, SNARE, CLAP, GENRES,
)


def _chord_pcs(name):
    c = parse_chord(name)
    return {(c["root"] + i) % 12 for i in c["intervals"]}


def test_read_prompt():
    r = read_prompt("late night drive, sad piano, hard drums, around 90 BPM")
    assert r["tempo"] == 90 and r["genre"] == "Lo-fi" and r["key"] is None, r
    r = read_prompt("trap beat in F# minor, 140 bpm, half-time")
    assert r == {"tempo": 140, "key": "F# minor", "genre": "Trap", "feel": "Half-time", "mode": None}, r
    # Mood decides major or minor when no key is named
    assert read_prompt("sad piano at night")["mode"] == "minor"
    assert read_prompt("happy summer pop")["mode"] == "major"
    for seed in range(40):
        assert compose(None, None, None, None, seed, mode="minor")["key"].endswith("minor")
        assert compose(None, None, None, None, seed, mode="major")["key"].endswith("major")
    r = read_prompt("house groove in B flat major")
    assert r["key"] == "Bb major" and r["genre"] == "House", r
    r = read_prompt("something at 900 bpm")
    assert r["tempo"] is None, "out-of-range tempo must be ignored"
    cases = {
        "trap beat 140bpm F#m": (140, "F# minor", "Trap"),
        "Bb minor drill": (None, "Bb minor", "Drill"),
        "c sharp minor ballad": (None, "C# minor", None),
        "folk song in G": (None, "G major", "Folk"),
        "Am I dreaming, dreamy synthwave": (None, None, "Synthwave"),
        "this needs to be a major hit, house": (None, None, "House"),
        "": (None, None, None),
    }
    for text, (tempo, key, genre) in cases.items():
        r = read_prompt(text)
        assert (r["tempo"], r["key"], r["genre"]) == (tempo, key, genre), f"{text!r}: {r}"
    print("  PASS: read_prompt")


def test_music_theory_ground_truth():
    for genre in GENRES:
        p = compose(genre, None, 96, "D minor", seed=11)
        key = parse_key(p["key"])
        scale = set(scale_of(key))
        bars = bar_map(p["sections"])
        total = len(bars) * 4
        assert p["tempo"] == 96 and p["key"] == "D minor"
        tracks = {t["id"]: t["notes"] for t in p["tracks"]}

        for s in p["sections"]:
            for c in s["chords"]:
                assert _chord_pcs(c) <= scale, f"{genre}: {c} is not diatonic to D minor"

        for n in sum(tracks.values(), []):
            assert isinstance(n["v"], int) and 1 <= n["v"] <= 127
            assert 0 <= n["t"] < total and n["d"] > 0

        for n in tracks["bass"]:
            bar = bars[int(n["t"] // 4)]
            pcs = _chord_pcs(bar["chord"])
            root = parse_chord(bar["chord"])["root"]
            on_downbeat = abs(n["t"] - round(n["t"] / 4) * 4) < 0.05
            if on_downbeat:
                assert n["p"] % 12 == root, f"{genre}: bass {n} on a downbeat is not the root of {bar['chord']}"
            elif GENRES[genre]["bass"] != "walking" and not n.get("glide"):
                assert n["p"] % 12 in pcs, f"{genre}: bass {n} is outside {bar['chord']}"
            assert 24 <= n["p"] <= 60

        for n in tracks["chords"]:
            bar = bars[int(n["t"] // 4)]
            assert n["p"] % 12 in _chord_pcs(bar["chord"]), f"{genre}: chord note {n} outside {bar['chord']}"

        for n in tracks["melody"]:
            assert n["p"] % 12 in scale, f"{genre}: melody note {n} is outside D minor"
            kind = bars[int(n["t"] // 4)]["sec"]["kind"]
            assert kind not in ("Intro", "Outro"), f"{genre}: melody in the {kind}"

        for n in tracks["drums"]:
            assert n["p"] in DRUM_PITCHES
        kicks = [n["t"] for n in tracks["drums"] if n["p"] == KICK]
        for b in range(len(bars)):
            assert any(abs(t - b * 4) < 0.05 for t in kicks), f"{genre}: no kick on bar {b + 1}"
    print("  PASS: music theory ground truth, all genres")


def test_every_genre_feel_key():
    """Every combination composes without error and stays in range."""
    from pipelines.composer import FEELS, NOTE_NAMES
    all_keys = [f"{r} {m}" for m in ("major", "minor") for r in NOTE_NAMES]
    n = 0
    for genre in GENRES:
        for feel in (None,) + FEELS:
            for key in all_keys:
                p = compose(genre, feel, None, key, seed=n)
                total = sum(s["bars"] for s in p["sections"]) * 4
                assert p["key"] == parse_key(key)["name"]
                for t in p["tracks"]:
                    assert t["notes"], f"{genre}/{feel}/{key}: empty {t['id']}"
                    for x in t["notes"]:
                        assert 0 <= x["t"] < total and 0 <= x["p"] <= 127 and 1 <= x["v"] <= 127
                n += 1
    print(f"  PASS: {n} genre x feel x key combinations")


def test_half_time_and_pinned_chords():
    p = compose("Indie rock", "Half-time", 120, "E major", seed=5, fills=False)
    drums = next(t["notes"] for t in p["tracks"] if t["id"] == "drums")
    backbeats = [n["t"] for n in drums if n["p"] in (SNARE, CLAP)]
    assert backbeats and all(abs(t % 4 - 2) < 0.05 for t in backbeats), "half-time snares must sit on beat 3"

    p = compose("Folk", None, 100, "A minor", seed=2, chords=["Am", "F", "C", "G"])
    for s in p["sections"]:
        assert s["chords"] == ["Am", "F", "C", "G"], s
    print("  PASS: half-time snares and pinned chords")


def test_seeded():
    a = compose("Trap", None, None, None, seed=42)
    b = compose("Trap", None, None, None, seed=42)
    c = compose("Trap", None, None, None, seed=43)
    assert a == b, "same seed must give the same project"
    assert a["tracks"] != c["tracks"], "a new seed must give different notes"
    secs = a["sections"]
    key = parse_key(a["key"])
    one = write_track("bass", secs, key, a["genre"], a["feel"], 42)
    assert one == next(t["notes"] for t in a["tracks"] if t["id"] == "bass"), "write_track must match compose"
    print("  PASS: seeded and deterministic")


def test_groove_follows_riff():
    """Kick and bass land on the riff's accents, and only there."""
    groove = [0, 0.75, 2.5]
    for genre in ("Indie rock", "Folk", "Lo-fi", "Trap"):
        p = compose(genre, None, 100, "A minor", seed=3, chords=["Am", "F", "C", "G"], groove=groove)
        assert p["groove"] == groove
        bars = bar_map(p["sections"])
        tracks = {t["id"]: t["notes"] for t in p["tracks"]}
        for b, info in enumerate(bars):
            if info["sec"]["kind"] in ("Intro", "Outro"):
                continue
            o = b * 4
            kicks = sorted(round((n["t"] - o) * 4) / 4 for n in tracks["drums"] if n["p"] == KICK and o <= n["t"] < o + 4)
            assert kicks == groove, f"{genre} bar {b + 1}: kicks {kicks}"
            onsets = sorted(round((n["t"] - o) * 4) / 4 for n in tracks["bass"] if o <= n["t"] < o + 4)
            assert onsets == groove, f"{genre} bar {b + 1}: bass onsets {onsets}"
    print("  PASS: kick and bass follow the riff groove")


# ─── Endpoints ───────────────────────────────────────────────────────────────

def _client():
    from fastapi.testclient import TestClient
    from sqlalchemy import create_engine
    from sqlalchemy.orm import sessionmaker
    import database
    from main import app

    # A file, not one shared in-memory connection: background jobs commit refunds from their own thread
    db_file = Path(tempfile.mkdtemp()) / "test.db"
    engine = create_engine(f"sqlite:///{db_file}", connect_args={"check_same_thread": False})
    database.Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine, autoflush=False, autocommit=False)

    def get_test_db():
        db = Session()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[database.get_db] = get_test_db
    return TestClient(app), Session


def _usage(client):
    r = client.get("/api/usage")
    assert r.status_code == 200, r.text
    return r.json()


def test_compose_endpoint():
    import database
    client, Session = _client()

    before = _usage(client)
    r = client.post("/api/studio/compose", json={"prompt": "late night drive, sad piano, hard drums, around 90 BPM"})
    assert r.status_code == 200, r.text
    p = r.json()
    assert p["tempo"] == 90 and p["genre"] == "Lo-fi" and len(p["tracks"]) == 4
    after = _usage(client)
    assert isinstance(after["used"], int) and after["used"] == before["used"] + 1
    assert p["usage"] == {"used": after["used"], "limit": after["limit"]}
    assert after["limit"] == 50, "usage_limit must stay at 50"

    # Explicit fields win over what the prompt says
    r = client.post("/api/studio/compose", json={"prompt": "90 bpm trap", "tempo": 120, "genre": "House", "key": "G major"})
    assert r.status_code == 200 and r.json()["tempo"] == 120 and r.json()["genre"] == "House" and r.json()["key"] == "G major"

    bad = [
        ({"tempo": 500}, "tempo"),
        ({"tempo": "fast"}, "tempo"),
        ({"genre": "Polka"}, "genre"),
        ({"feel": "Spooky"}, "feel"),
        ({"key": "H minor"}, "key"),
        ({"chords": ["Xm"]}, "chords"),
        ({"chords": []}, "chords"),
        ({"prompt": "x" * 501}, "prompt"),
        ({"groove": [0, 4.5]}, "groove"),
        ({"groove": []}, "groove"),
    ]
    used = _usage(client)["used"]
    for body, field in bad:
        r = client.post("/api/studio/compose", json=body)
        assert r.status_code == 400, f"{body} -> {r.status_code} {r.text}"
        assert r.json()["detail"].startswith(field), r.json()
    for raw in (b"not json", b"[1, 2]", b""):
        r = client.post("/api/studio/compose", content=raw, headers={"Content-Type": "application/json"})
        assert r.status_code == 400, f"{raw!r} -> {r.status_code}"
    assert _usage(client)["used"] == used, "rejected requests must not count"

    # A recording-based layout: sections exactly as given, chords restarting each section
    structure = [{"kind": "Intro", "bars": 3}, {"kind": "Verse", "bars": 6}, {"kind": "Outro", "bars": 3}]
    r = client.post("/api/studio/compose", json={"chords": ["Am", "F", "C"], "structure": structure, "tempo": 100, "key": "A minor"})
    assert r.status_code == 200, r.text
    assert [(x["kind"], x["bars"]) for x in r.json()["sections"]] == [("Intro", 3), ("Verse", 6), ("Outro", 3)]
    assert all(x["chords"] == ["Am", "F", "C"] for x in r.json()["sections"])
    for bad in ([{"kind": "Solo", "bars": 4}], [{"kind": "Verse", "bars": 0}], [{"kind": "Verse", "bars": 64}] * 5, []):
        r = client.post("/api/studio/compose", json={"structure": bad})
        assert r.status_code == 400, f"{bad} -> {r.status_code}"

    # At the limit: 429 and nothing charged
    db = Session()
    u = db.get(database.User, "dev")
    u.usage_count = u.usage_limit
    db.commit()
    db.close()
    r = client.post("/api/studio/compose", json={"prompt": "anything"})
    assert r.status_code == 429, r.text
    assert _usage(client)["used"] == 50
    print("  PASS: /api/studio/compose")


def test_regenerate_endpoint():
    client, _ = _client()
    p = client.post("/api/studio/compose", json={"genre": "Trap", "key": "C# minor", "tempo": 140}).json()
    used = _usage(client)["used"]
    body = {"track": "drums", "key": p["key"], "genre": p["genre"], "feel": p["feel"],
            "sections": p["sections"], "seed": 9, "start_beat": 16, "end_beat": 20}
    r = client.post("/api/studio/regenerate", json=body)
    assert r.status_code == 200, r.text
    notes = r.json()["notes"]
    assert notes and all(16 <= n["t"] < 20 for n in notes)
    assert _usage(client)["used"] == used, "regenerating must be free"

    full = client.post("/api/studio/regenerate", json={**body, "start_beat": None, "end_beat": None, "track": "bass"})
    assert full.status_code == 200 and len(full.json()["notes"]) > len(notes)

    bad = [
        {**body, "track": "vocals"},
        {**body, "genre": "Polka"},
        {**body, "key": "Q major"},
        {**body, "seed": -1},
        {**body, "start_beat": 20, "end_beat": 16},
        {**body, "sections": []},
        {**body, "sections": [{"id": "a", "kind": "Verse", "bars": 64, "chords": ["Am"]}] * 5},
        {**body, "sections": [{"id": "a", "kind": "Solo", "bars": 4, "chords": ["Am"]}]},
        {**body, "sections": [{"id": "a", "kind": "Verse", "bars": 4, "chords": ["Am", "Z"]}]},
        {k: v for k, v in body.items() if k != "seed"},
        {**body, "groove": [-1]},
    ]
    for b in bad:
        r = client.post("/api/studio/regenerate", json=b)
        assert r.status_code == 400, f"{r.status_code} {r.text}"
    print("  PASS: /api/studio/regenerate")


def test_analyze_riff_endpoint():
    from test_riff_analysis import synth_riff
    client, _ = _client()

    r = client.post("/api/studio/analyze-riff")
    assert r.status_code == 400, r.text
    r = client.post("/api/studio/analyze-riff", files={"riff": ("riff.wav", b"", "audio/wav")})
    assert r.status_code == 400, r.text
    r = client.post("/api/studio/analyze-riff", files={"riff": ("riff.wav", b"RIFF garbage", "audio/wav")})
    assert r.status_code == 400, r.text

    with tempfile.TemporaryDirectory() as tmp:
        path = str(Path(tmp) / "riff.wav")
        synth_riff(path, ["Am", "F", "C", "G"], 100.0, 0.25)
        data = Path(path).read_bytes()
    for bad in ({"tempo": "fast"}, {"tempo": "500"}, {"start": "-1"}, {"start": "99"}):
        r = client.post("/api/studio/analyze-riff", files={"riff": ("riff.wav", io.BytesIO(data), "audio/wav")}, data=bad)
        assert r.status_code == 400, f"{bad} -> {r.status_code} {r.text}"
    r = client.post("/api/studio/analyze-riff", files={"riff": ("riff.wav", io.BytesIO(data), "audio/wav")}, data={"tempo": "100", "start": "0.25"})
    assert r.status_code == 200 and r.json()["start"] == 0.25 and r.json()["tempo"] == 100.0, r.text
    r = client.post("/api/studio/analyze-riff", files={"riff": ("riff.wav", io.BytesIO(data), "audio/wav")})
    assert r.status_code == 200, r.text
    j = r.json()
    assert abs(j["tempo"] - 100) <= 1.5 and j["key"] == "A minor"
    assert [c["chord"] for c in j["chords"]][:4] == ["Am", "F", "C", "G"]
    for bad in ({"instrument": "kazoo"},):
        r = client.post("/api/studio/analyze-riff", files={"riff": ("riff.wav", io.BytesIO(data), "audio/wav")}, data=bad)
        assert r.status_code == 400, r.text
    r = client.post("/api/studio/analyze-riff", files={"riff": ("riff.wav", io.BytesIO(data), "audio/wav")}, data={"instrument": "harmonic"})
    assert r.status_code == 200 and r.json()["kind"] == "harmonic"
    print("  PASS: /api/studio/analyze-riff")


if __name__ == "__main__":
    print("=" * 50)
    test_read_prompt()
    test_music_theory_ground_truth()
    test_every_genre_feel_key()
    test_half_time_and_pinned_chords()
    test_seeded()
    test_groove_follows_riff()
    test_compose_endpoint()
    test_regenerate_endpoint()
    test_analyze_riff_endpoint()
    print("=" * 50)
    print("All tests passed.")
