"""OpenAI GPT-4o-mini endpoints for prompt enhancement and lyrics generation."""

import os
from fastapi import APIRouter, Form
from fastapi.responses import JSONResponse

router = APIRouter()

OPENAI_API_KEY = os.environ.get("OPENAI_API_KEY", "")


def _get_client():
    from openai import OpenAI
    return OpenAI(api_key=OPENAI_API_KEY)


@router.post("/enhance-prompt")
async def enhance_prompt(
    rough_prompt: str = Form(""),
    genre: str = Form(""),
):
    if not OPENAI_API_KEY:
        return JSONResponse(
            status_code=503,
            content={"detail": "OpenAI API key not configured"},
        )

    rough = rough_prompt.strip()
    if not rough:
        return JSONResponse(status_code=400, content={"detail": "Prompt is required"})

    genre_hint = f" The user wants a {genre} track." if genre.strip() else ""

    client = _get_client()
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a music production prompt engineer. "
                    "Take the user's rough song description and transform it into a polished, "
                    "detailed music generation prompt that will produce a high-quality AI-generated song. "
                    "Include specifics about genre, mood, instrumentation, vocal style, tempo feel, "
                    "energy, and sonic texture. Be vivid and precise. "
                    "Keep it under 150 words. Output ONLY the enhanced prompt, nothing else."
                    + genre_hint
                ),
            },
            {"role": "user", "content": rough},
        ],
        max_tokens=300,
        temperature=0.8,
    )

    enhanced = resp.choices[0].message.content.strip()
    return {"enhanced_prompt": enhanced}


@router.post("/ai-generate-lyrics")
async def ai_generate_lyrics(
    theme: str = Form(""),
    genre: str = Form("pop"),
    mood: str = Form(""),
):
    if not OPENAI_API_KEY:
        return JSONResponse(
            status_code=503,
            content={"detail": "OpenAI API key not configured"},
        )

    theme_text = theme.strip() or "life and dreams"
    genre_text = genre.strip() or "pop"
    mood_text = f" The mood should be {mood.strip()}." if mood.strip() else ""

    client = _get_client()
    resp = client.chat.completions.create(
        model="gpt-4o-mini",
        messages=[
            {
                "role": "system",
                "content": (
                    "You are a professional songwriter. Write complete song lyrics. "
                    "Use standard song structure with tags: [Intro], [Verse 1], [Pre-Chorus], "
                    "[Chorus], [Verse 2], [Bridge], [Outro]. "
                    "Make lyrics vivid, emotional, and genre-appropriate. "
                    "Use line breaks within sections. "
                    "Output ONLY the lyrics with section tags, nothing else."
                    + mood_text
                ),
            },
            {
                "role": "user",
                "content": f"Write {genre_text} song lyrics about: {theme_text}",
            },
        ],
        max_tokens=800,
        temperature=0.9,
    )

    lyrics = resp.choices[0].message.content.strip()
    return {"lyrics": lyrics}
