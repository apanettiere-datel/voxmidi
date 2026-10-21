"""Claude as the studio's composer brain: plain-language edits to MIDI parts.

The endpoint sends the whole song (sections, chords, and every track's notes in
the project's {p,t,d,v} format) plus the user's request to Claude, and gets back
up to four changes: new note lists for existing tracks, or brand-new tracks with
a role the studio knows (drums, bass, chords, melody). When the request carries
a scope (one section's beat range), Claude returns only the notes inside it and
the client splices them in, so notes outside the scope are kept mechanically,
not on trust. Structured outputs enforce the schema on the API side, and
validate_changes() re-checks everything before any note reaches the timeline.
The frontend keeps its before/after preview, so nothing lands unless the user
keeps it.

Provider selection:
  ANTHROPIC_API_KEY set -> "claude" (real API)
  unset -> "off" (the endpoint 503s and the frontend falls back to rule-based)
"""

import json
import os

import anthropic

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
MAX_NOTES = 20000
MAX_CHANGES = 4
NEW_ROLES = ("drums", "bass", "chords", "melody")

SYSTEM = """You are the composer inside VoxMIDI, a small web music studio. The user asks for a change to their song in plain language; you write or rewrite the notes of one or more tracks.

Notes are objects {"p": MIDI pitch 0-127, "t": start in beats from the start of the song, "d": length in beats, "v": velocity 1-127}. Beats are quarter notes; bars are 4 beats. Drum tracks use General MIDI pitches: 36 kick, 38 snare, 39 clap, 42 closed hat, 46 open hat, 75 percussion.

Rules:
- Make the smallest set of changes the request needs: usually one track, at most 4.
- Each change names an existing track by its id, or "new" to add a track. A new track needs a "role" (drums, bass, chords or melody: pick the closest; a pad or strings part is chords, a hook or line is melody) and a short "name". Add a track only for a part the request asks for that the song doesn't have.
- When the song has no "scope": return the COMPLETE new note list for each changed track, including every note you did not change. Notes you leave out are deleted.
- When the song has a "scope" (the request applies only to beats scope.start_beat up to scope.end_beat): return ONLY notes inside that range; everything outside it is kept automatically. An existing track with an empty "notes" list means you cleared that range on purpose.
- Stay in the song's key and follow each section's chords. Keep notes inside the song (t < total beats).
- Musical judgment is yours: voice leading, velocity shape and pocket matter more than density.
- "title" is one short plain sentence saying what you did. "detail" is one short sentence saying what you kept. No jargon."""

# The structured-outputs grammar takes types, required, additionalProperties and
# enums, but no numeric/length/count constraints (maxItems, minimum, maxLength all
# 400). The prompt states the ranges and validate_changes() enforces every limit
# after the call, so the schema stays plain.
NOTES_SCHEMA = {
    "type": "array",
    "items": {
        "type": "object",
        "properties": {
            "p": {"type": "integer"},
            "t": {"type": "number"},
            "d": {"type": "number"},
            "v": {"type": "integer"},
        },
        "required": ["p", "t", "d", "v"],
        "additionalProperties": False,
    },
}

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "detail": {"type": "string"},
        "changes": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "track": {"type": "string"},
                    "role": {"type": "string", "enum": list(NEW_ROLES)},
                    "name": {"type": "string"},
                    "notes": NOTES_SCHEMA,
                },
                "required": ["track", "notes"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "detail", "changes"],
    "additionalProperties": False,
}


class ComposerError(Exception):
    """A readable problem to show the user (bad request, refusal, bad reply)."""


def provider_name() -> str:
    return "claude" if os.environ.get("ANTHROPIC_API_KEY") else "off"


async def _structured_call(system: str, user_content: str, schema: dict, label: str, too_big: str) -> dict:
    """One structured-output call to Claude; every failure becomes a ComposerError."""
    # A user-scoped key (sk-ant-usr-...) only works with a workspace id alongside it
    workspace = os.environ.get("ANTHROPIC_WORKSPACE_ID")
    client = anthropic.AsyncAnthropic(default_headers={"anthropic-workspace-id": workspace} if workspace else None)
    try:
        async with client.messages.stream(
            model=MODEL,
            max_tokens=64000,
            system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
            output_config={"format": {"type": "json_schema", "schema": schema}, "effort": "high"},
            messages=[{"role": "user", "content": user_content}],
        ) as stream:
            msg = await stream.get_final_message()
    except anthropic.AuthenticationError:
        raise ComposerError("The AI key on this server is not valid.")
    except anthropic.RateLimitError:
        raise ComposerError("The AI is rate limited right now. Try again in a minute.")
    except anthropic.APIStatusError as exc:
        raise ComposerError(f"The AI service returned an error ({exc.status_code}). Try again.")
    except anthropic.APIConnectionError:
        raise ComposerError("Couldn't reach the AI service. Check the server's network.")

    if msg.stop_reason == "refusal":
        why = (msg.stop_details.explanation if msg.stop_details else None) or "it declined that request"
        raise ComposerError(f"The AI didn't do it: {why}")
    if msg.stop_reason == "max_tokens":
        raise ComposerError(too_big)

    out = next((b.text for b in msg.content if b.type == "text"), "")
    print(f"[studio] {label} model={MODEL} in={msg.usage.input_tokens} out={msg.usage.output_tokens}")
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        raise ComposerError("The AI reply wasn't readable. Try again.")


async def ask_claude(song: dict, text: str) -> dict:
    """One structured-output call: song context + request in, a list of track changes out."""
    content = json.dumps({"song": song, "request": text}, separators=(",", ":"))
    return await _structured_call(SYSTEM, content, SCHEMA, "ask-ai",
                                  "That change came out too large. Ask for one section at a time.")


def _clean_notes(notes: list, lo: float, hi: float) -> list:
    """Clamp each note into range and drop the ones outside [lo, hi)."""
    clean = []
    for n in notes:
        p, t, d, v = n.get("p"), n.get("t"), n.get("d"), n.get("v")
        if not all(isinstance(x, (int, float)) for x in (p, t, d, v)):
            raise ComposerError("The AI reply had a malformed note. Nothing was changed.")
        if t < lo or t >= hi:
            continue  # drop notes outside the edit range rather than failing the whole edit
        clean.append({
            "p": int(max(0, min(127, p))),
            "t": float(t),
            "d": float(max(0.02, min(64, d))),
            "v": int(max(1, min(127, v))),
        })
    clean.sort(key=lambda n: (n["t"], n["p"]))
    return clean


def validate_changes(data: dict, tracks: list, max_beat: float, scope: dict | None = None) -> dict:
    """Re-check Claude's reply before any note reaches the timeline."""
    by_id = {t["id"]: t for t in tracks}
    lo = float(scope["start_beat"]) if scope else 0.0
    hi = min(float(scope["end_beat"]), max_beat) if scope else max_beat
    raw = data.get("changes") or []
    if not raw:
        raise ComposerError("The AI changed nothing. Nothing was changed.")
    if len(raw) > MAX_CHANGES:
        raise ComposerError("The AI reply changed too many tracks. Nothing was changed.")

    seen = set()
    changes = []
    for ch in raw:
        notes = ch.get("notes") or []
        if len(notes) > MAX_NOTES:
            raise ComposerError("The AI reply had too many notes. Nothing was changed.")
        clean = _clean_notes(notes, lo, hi)
        if ch.get("track") == "new":
            role = ch.get("role")
            if role not in NEW_ROLES:
                raise ComposerError("The AI added a track with an instrument this studio doesn't have. Try again.")
            if not clean:
                raise ComposerError("The AI added a track with no notes in it. Nothing was changed.")
            changes.append({
                "created": True,
                "role": role,
                "name": (ch.get("name") or role.title())[:24],
                "notes": clean,
            })
        else:
            track = by_id.get(ch.get("track"))
            if track is None:
                raise ComposerError("The AI named a track that isn't in this song. Try again.")
            if track["id"] in seen:
                raise ComposerError("The AI changed the same track twice. Nothing was changed.")
            seen.add(track["id"])
            if notes and not clean:
                raise ComposerError("Every note in the AI reply fell outside the edit range. Nothing was changed.")
            if not clean and scope is None:
                raise ComposerError("The AI removed every note on that track. Nothing was changed.")
            changes.append({
                "created": False,
                "trackId": track["id"],
                "trackName": track.get("name", track["id"]),
                "notes": clean,
            })
    return {
        "title": (data.get("title") or "Changed the part.")[:140],
        "detail": (data.get("detail") or "")[:200],
        "scope": scope,
        "changes": changes,
    }


# ─── Whole-song composition: one brief in, a complete arrangement out ─────────

SONG_ROLES = ("drums", "bass", "chords", "melody")
SONG_SECTION_KINDS = ("Intro", "Verse", "Chorus", "Bridge", "Outro")
MAX_SONG_BARS = 64

SONG_SYSTEM = """You are a songwriter and arranger inside VoxMIDI, a small web music studio. From one plain-language brief you compose a complete short song as MIDI, plus lyrics for a singer.

Notes are objects {"p": MIDI pitch 0-127, "t": start in beats from the song start, "d": length in beats, "v": velocity 1-127}. Beats are quarter notes; bars are 4 beats. Drum tracks use only these General MIDI pitches: 36 kick, 38 snare, 39 clap, 42 closed hat, 46 open hat, 75 percussion.

Deliver:
- "sections": the song form in order, each {"kind": Intro/Verse/Chorus/Bridge/Outro, "bars": length, "chords": chord symbols cycled through its bars, like ["Am","F","C","G"]}. Use plain symbols (Am, F, G7, Cmaj7). 16 to 32 bars in total.
- "tracks": exactly four, one per role. "drums", "bass", "chords" (the harmony instrument) and "melody". The melody is the VOCAL GUIDE: a singable line in a comfortable vocal register (roughly MIDI 55-79) with rests between phrases; a singer will follow it, so phrase it like words.
- "lyrics": verse/chorus words under [verse] and [chorus] tags whose lines fit the melody's phrasing, matching the brief's subject and mood.
- "caption": one line for the music generator describing genre, tempo in BPM, instrumentation and the lead vocal's character.
- "tempo" 40-240, "key" like "A minor", and a short "title".

Musical judgment matters: real voice leading in the chords, a bass line with a pocket (not just roots), shaped velocities, intro and outro lighter than the chorus. Every note must start inside the song (t < total bars x 4)."""

SONG_SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "tempo": {"type": "integer"},
        "key": {"type": "string"},
        "caption": {"type": "string"},
        "lyrics": {"type": "string"},
        "sections": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "kind": {"type": "string", "enum": list(SONG_SECTION_KINDS)},
                    "bars": {"type": "integer"},
                    "chords": {"type": "array", "items": {"type": "string"}},
                },
                "required": ["kind", "bars", "chords"],
                "additionalProperties": False,
            },
        },
        "tracks": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "role": {"type": "string", "enum": list(SONG_ROLES)},
                    "name": {"type": "string"},
                    "notes": NOTES_SCHEMA,
                },
                "required": ["role", "name", "notes"],
                "additionalProperties": False,
            },
        },
    },
    "required": ["title", "tempo", "key", "caption", "lyrics", "sections", "tracks"],
    "additionalProperties": False,
}


async def compose_song(brief: str) -> dict:
    """One structured-output call: a plain-language brief in, a whole song out."""
    return await _structured_call(SONG_SYSTEM, brief, SONG_SCHEMA, "song-ai",
                                  "That song came out too large. Ask for a shorter one.")


def validate_song(data: dict) -> dict:
    """Re-check Claude's song before it reaches the client."""
    try:
        tempo = int(data.get("tempo") or 0)
    except (TypeError, ValueError):
        tempo = 0
    if not (40 <= tempo <= 240):
        raise ComposerError("The AI picked an unusable tempo. Try again.")

    raw_sections = data.get("sections") or []
    if not raw_sections or len(raw_sections) > 16:
        raise ComposerError("The AI wrote an unusable song form. Try again.")
    sections, total_bars = [], 0
    for i, s in enumerate(raw_sections):
        kind = s.get("kind")
        bars = s.get("bars")
        if kind not in SONG_SECTION_KINDS or not isinstance(bars, int) or not (1 <= bars <= 32):
            raise ComposerError("The AI wrote an unusable song form. Try again.")
        chords = [str(c).strip()[:12] for c in (s.get("chords") or []) if str(c).strip()][:8]
        total_bars += bars
        sections.append({"id": f"s{i + 1}", "kind": kind, "bars": bars, "chords": chords})
    if total_bars > MAX_SONG_BARS:
        raise ComposerError("The AI wrote too long a song. Try again.")
    total_beats = total_bars * 4.0

    tracks, seen = [], set()
    for tr in data.get("tracks") or []:
        role = tr.get("role")
        if role not in SONG_ROLES or role in seen:
            continue  # drop a duplicate or unknown role rather than failing the song
        seen.add(role)
        notes = tr.get("notes") or []
        if len(notes) > MAX_NOTES:
            raise ComposerError("The AI reply had too many notes. Try again.")
        tracks.append({
            "role": role,
            "name": (tr.get("name") or role.title())[:24],
            "notes": _clean_notes(notes, 0.0, total_beats),
        })
    if not any(t["notes"] for t in tracks):
        raise ComposerError("The AI wrote a song with no notes. Try again.")

    return {
        "title": (str(data.get("title") or "").strip() or "Untitled song")[:60],
        "tempo": tempo,
        "key": str(data.get("key") or "")[:12],
        "caption": str(data.get("caption") or "")[:300],
        "lyrics": str(data.get("lyrics") or "")[:2000],
        "sections": sections,
        "tracks": tracks,
    }
