"""Template-based lyrics generator — /api/generate-lyrics"""

from fastapi import APIRouter, Form
from fastapi.responses import JSONResponse

router = APIRouter()


def _template_lyrics(theme: str, genre: str) -> str:
    theme = theme.strip() or "life and dreams"
    g = genre.lower().replace(' ', '-').replace('_', '-')
    t = theme.capitalize()

    if g in ('edm', 'house', 'techno', 'drum-and-bass'):
        return f"""[Verse 1]
Feel the pulse beneath your feet
{t} calling through the heat
Neon lights and open skies
Let the music lift you higher

[Pre-Chorus]
We keep rising, can't stop now
The wave is building, take a bow

[Chorus]
We are alive in the light
{t} burning so bright
Let it go, let it flow
In the dark, watch us glow
We are alive — tonight

[Verse 2]
Close your eyes and lose yourself
Leave your worries on the shelf
Every heartbeat on the floor
This is what we're living for

[Pre-Chorus]
We keep rising, can't stop now
The wave is building, take a bow

[Chorus]
We are alive in the light
{t} burning so bright
Let it go, let it flow
In the dark, watch us glow
We are alive — tonight

[Bridge]
We rise, we rise
Under electric skies
We rise, we rise
Open your eyes — tonight

[Outro]
Let it go... let it flow...
We are alive"""

    elif g in ('trap', 'hip-hop', 'r-and-b', 'r&b'):
        return f"""[Intro]
Yeah... {t}...
They never saw it coming

[Verse 1]
Started from the bottom, no apology
{t} in my veins, it's my philosophy
Every late night, every sacrifice
Now they all watching, paying double the price
I was in the dark, now I'm shining bright
Grind don't stop, yeah we going all night
They said I couldn't do it, I was never wrong
Now I'm writing history, moving all along

[Chorus]
{t} — that's what I carry
Made it through the storm, now I'm legendary
Came up from nothing, built it with my hands
Living out my dreams just like I always planned
{t} — that's what I carry

[Verse 2]
Every scar I wear like a badge of pride
{t} is the only thing that's kept me alive
From the struggle to the penthouse, every step I own
When they count me out, that's when I really shown
Running through the city with my head held high
Chasing every vision underneath this sky

[Chorus]
{t} — that's what I carry
Made it through the storm, now I'm legendary
Came up from nothing, built it with my hands
Living out my dreams just like I always planned
{t} — that's what I carry

[Bridge]
They can try to take it
But they can't erase it
{t} is forever
We'll make it, make it

[Outro]
{t}... yeah...
This is my story"""

    elif g in ('pop', 'rock', 'punk', 'indie'):
        return f"""[Verse 1]
I wake up in the morning with {t} on my mind
The world outside is calling, leaving doubts behind
I've been holding onto something I can't let go
But today I turn the page and let the whole world know

[Pre-Chorus]
So here I stand, arms open wide
Ready for whatever comes, I've got nothing to hide

[Chorus]
This is my moment, this is my time
{t} is everything — and it's finally mine
Through every storm, through every fall
I found my voice, I found it all
This is my moment — I'm answering the call

[Verse 2]
There were nights I thought the darkness would never end
But the light came through the cracks, and I found a friend
In myself, in the music, in the beat of my own heart
Now I'm standing at the finish where I always had the start

[Pre-Chorus]
So here I stand, arms open wide
Ready for whatever comes, I've got nothing to hide

[Chorus]
This is my moment, this is my time
{t} is everything — and it's finally mine
Through every storm, through every fall
I found my voice, I found it all
This is my moment — I'm answering the call

[Bridge]
I'm not the same as yesterday
{t} showed me the way
I'm not the same as yesterday
And I wouldn't have it any other way

[Final Chorus]
This is my moment, this is my time
{t} is everything — and it's finally mine
Through every storm, through every fall
I found my voice, I found it all
This is my moment — I'm answering the call

[Outro]
This is my moment...
{t}..."""

    elif g in ('jazz', 'blues', 'soul'):
        return f"""[Verse 1]
Sitting by the window when the rain came down
{t} on my shoulders, wearing a crown
Of thorns and roses, honey, that's the price
Of loving something beautiful that cuts you twice

[Chorus]
Oh, {t.lower()}
You got me tangled in your sweet refrain
Oh, {t.lower()}
You're the sunshine and the pouring rain

[Verse 2]
I've been around the world and back again
{t} follows me like a faithful friend
In every city, in every bar-room song
I hear your echo, baby, where I belong

[Chorus]
Oh, {t.lower()}
You got me tangled in your sweet refrain
Oh, {t.lower()}
You're the sunshine and the pouring rain

[Bridge]
I could try to walk away
But every road leads back to you
{t} is all I need to say
To know that something good is true

[Outro]
Oh, {t.lower()}...
Mm-hmm..."""

    elif g in ('ambient', 'classical', 'new-age'):
        return f"""[Intro]
{t}...
Like water finding its way...

[Verse 1]
Breathe in the silence
{t} fills the space between the stars
Let go of the distance
We are all wanderers of the dark

[Bridge]
Float like the river to the sea
{t} carries you and me
Infinite and gentle, ever free

[Verse 2]
Close your eyes and listen
{t} whispers in the wind
Let the light come in now
Where does one life end, another begin?

[Bridge]
Float like the river to the sea
{t} carries you and me
Infinite and gentle, ever free

[Outro]
{t}...
Always was, always will be...
{t}..."""

    elif g in ('synthwave', 'retrowave', 'electro'):
        return f"""[Verse 1]
{t} on a Friday night, 1985
We were young and fearless, barely staying alive
Driving down the highway under neon skies
Living in a future that we couldn't recognize

[Pre-Chorus]
But something in the static
Something in the chrome
Told us we were magic
Told us this was home

[Chorus]
{t} — in the city lights
{t} — on electric nights
We never knew how fast we'd fly
Through the neon and the midnight sky
{t} — burning through the years
{t} — beyond our fears

[Verse 2]
Everything is retro, everything is new
{t} in the mirror, staring back at you
Synthesizers singing, drumming in the dark
Keeping all the embers glowing in your heart

[Pre-Chorus]
Something in the static
Something in the chrome
Told us we were magic
Told us this was home

[Chorus]
{t} — in the city lights
{t} — on electric nights
We never knew how fast we'd fly
Through the neon and the midnight sky
{t} — burning through the years
{t} — beyond our fears

[Bridge]
Take me back to when
{t} was all we had
The good, the beautiful, the bad
Racing through the night again

[Outro]
{t}...
In the neon glow...
We never really let it go..."""

    else:
        # generic / lo-fi
        return f"""[Verse 1]
{t} in the morning light
Everything feels almost right
Slow down, breathe it in
Let the day begin

[Chorus]
Yeah, {t.lower()}
Keeps me going on
{t.lower()}
Even when I'm gone
It's the only thing
That makes sense anymore
{t.lower()}
That's what I'm here for

[Verse 2]
Coffee going cold again
Lost in thought and wondering when
{t} comes around
Quiet, underground

[Chorus]
Yeah, {t.lower()}
Keeps me going on
{t.lower()}
Even when I'm gone
It's the only thing
That makes sense anymore
{t.lower()}
That's what I'm here for

[Bridge]
Some days feel like standing still
{t} bends against my will
But I find my way back
Every time

[Outro]
{t.lower()}...
Just like that..."""


@router.post("/generate-lyrics")
async def generate_lyrics(
    theme: str = Form(""),
    genre: str = Form("pop"),
):
    """Generate song lyrics from a theme and genre using templates."""
    lyrics = _template_lyrics(theme, genre)
    return {"lyrics": lyrics}
