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

NOTES_SCHEMA = {
    "type": "array",
    "maxItems": MAX_NOTES,
    "items": {
        "type": "object",
        "properties": {
            "p": {"type": "integer", "minimum": 0, "maximum": 127},
            "t": {"type": "number", "minimum": 0},
            "d": {"type": "number", "exclusiveMinimum": 0, "maximum": 64},
            "v": {"type": "integer", "minimum": 1, "maximum": 127},
        },
        "required": ["p", "t", "d", "v"],
        "additionalProperties": False,
    },
}

SCHEMA = {
    "type": "object",
    "properties": {
        "title": {"type": "string", "maxLength": 140},
        "detail": {"type": "string", "maxLength": 200},
        "changes": {
            "type": "array",
            "minItems": 1,
            "maxItems": MAX_CHANGES,
            "items": {
                "type": "object",
                "properties": {
                    "track": {"type": "string", "maxLength": 24},
                    "role": {"type": "string", "enum": list(NEW_ROLES)},
                    "name": {"type": "string", "maxLength": 24},
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


async def ask_claude(song: dict, text: str) -> dict:
    """One structured-output call: song context + request in, a list of track changes out."""
    # A user-scoped key (sk-ant-usr-...) only works with a workspace id alongside it
    workspace = os.environ.get("ANTHROPIC_WORKSPACE_ID")
    client = anthropic.AsyncAnthropic(default_headers={"anthropic-workspace-id": workspace} if workspace else None)
    try:
        async with client.messages.stream(
            model=MODEL,
            max_tokens=64000,
            system=[{"type": "text", "text": SYSTEM, "cache_control": {"type": "ephemeral"}}],
            output_config={"format": {"type": "json_schema", "schema": SCHEMA}, "effort": "high"},
            messages=[{
                "role": "user",
                "content": json.dumps({"song": song, "request": text}, separators=(",", ":")),
            }],
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
        raise ComposerError(f"The AI didn't make that change: {why}")
    if msg.stop_reason == "max_tokens":
        raise ComposerError("That change came out too large. Ask for one section at a time.")

    out = next((b.text for b in msg.content if b.type == "text"), "")
    print(f"[studio] ask-ai model={MODEL} in={msg.usage.input_tokens} out={msg.usage.output_tokens}")
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        raise ComposerError("The AI reply wasn't readable. Try again.")


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
