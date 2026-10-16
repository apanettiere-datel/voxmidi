"""Claude as the studio's composer brain: plain-language edits to MIDI parts.

The endpoint sends the whole song (sections, chords, and every track's notes in
the project's {p,t,d,v} format) plus the user's request to Claude, and gets back
a complete replacement note list for ONE track. Structured outputs enforce the
note schema on the API side, and validate_result() re-checks everything before
any note reaches the timeline. The frontend keeps its before/after preview, so
nothing lands unless the user keeps it.

Provider selection:
  ANTHROPIC_API_KEY set -> "claude" (real API)
  unset -> "off" (the endpoint 503s and the frontend falls back to rule-based)
"""

import json
import os

import anthropic

MODEL = os.environ.get("CLAUDE_MODEL", "claude-opus-5-5")
MAX_NOTES = 20000

SYSTEM = """You are the composer inside VoxMIDI, a small web music studio. The user asks for a change to their song in plain language; you rewrite the notes of exactly one track.

Notes are objects {"p": MIDI pitch 0-127, "t": start in beats from the start of the song, "d": length in beats, "v": velocity 1-127}. Beats are quarter notes; bars are 4 beats. Drum tracks use General MIDI pitches: 36 kick, 38 snare, 39 clap, 42 closed hat, 46 open hat, 75 percussion.

Rules:
- Change exactly one track: the one the request names, or the one it most clearly means.
- Return the COMPLETE new note list for that track, including every note you did not change. Notes you leave out are deleted.
- When the request names a section (verse, chorus...), change notes only inside that section's beat range and copy the rest unchanged.
- Stay in the song's key and follow each section's chords. Keep notes inside the song (t < total beats).
- Musical judgment is yours: voice leading, velocity shape and pocket matter more than density.
- "title" is one short plain sentence saying what you did. "detail" is one short sentence saying what you kept. No jargon."""

SCHEMA = {
    "type": "object",
    "properties": {
        "track": {"type": "string", "maxLength": 24},
        "title": {"type": "string", "maxLength": 140},
        "detail": {"type": "string", "maxLength": 200},
        "notes": {
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
        },
    },
    "required": ["track", "title", "detail", "notes"],
    "additionalProperties": False,
}


class ComposerError(Exception):
    """A readable problem to show the user (bad request, refusal, bad reply)."""


def provider_name() -> str:
    return "claude" if os.environ.get("ANTHROPIC_API_KEY") else "off"


async def ask_claude(song: dict, text: str) -> dict:
    """One structured-output call: song context + request in, one track's new notes out."""
    client = anthropic.AsyncAnthropic()
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


def validate_result(data: dict, tracks: list, max_beat: float) -> dict:
    """Re-check Claude's reply before any note reaches the timeline."""
    by_id = {t["id"]: t for t in tracks}
    track = by_id.get(data.get("track"))
    if track is None:
        raise ComposerError("The AI named a track that isn't in this song. Try again.")
    notes = data.get("notes") or []
    if not notes:
        raise ComposerError("The AI removed every note on that track. Nothing was changed.")
    if len(notes) > MAX_NOTES:
        raise ComposerError("The AI reply had too many notes. Nothing was changed.")
    clean = []
    for n in notes:
        p, t, d, v = n.get("p"), n.get("t"), n.get("d"), n.get("v")
        if not all(isinstance(x, (int, float)) for x in (p, t, d, v)):
            raise ComposerError("The AI reply had a malformed note. Nothing was changed.")
        if t >= max_beat or t < 0:
            continue  # drop notes outside the song rather than failing the whole edit
        clean.append({
            "p": int(max(0, min(127, p))),
            "t": float(t),
            "d": float(max(0.02, min(64, d))),
            "v": int(max(1, min(127, v))),
        })
    if not clean:
        raise ComposerError("Every note in the AI reply fell outside the song. Nothing was changed.")
    clean.sort(key=lambda n: (n["t"], n["p"]))
    return {
        "trackId": track["id"],
        "trackName": track.get("name", track["id"]),
        "title": (data.get("title") or "Changed the part.")[:140],
        "detail": (data.get("detail") or "")[:200],
        "notes": clean,
    }
