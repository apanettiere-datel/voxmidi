// AI Cover sound library, organized GarageBand-style: a category list, and the
// named sounds inside each. Each sound is curated caption words for ACE-Step;
// picking one fills the (still editable) sound-words box in the inspector.
// Shape: { [part]: [ { category, sounds: [{ name, vibe }] } ] }

export const SOUND_LIBRARY = {
  bass: [
    { category: 'Electric', sounds: [
      { name: 'Warm vintage', vibe: 'warm round vintage electric bass, soft attack, tape saturation' },
      { name: 'Picked punk', vibe: 'picked punk rock bass, punchy midrange, driving' },
      { name: 'Motown finger', vibe: 'fingered Motown electric bass, deep and melodic, flatwound strings' },
      { name: 'Slap funk', vibe: 'funky slap bass, bright and percussive, thumbed and popped' },
    ]},
    { category: 'Synth', sounds: [
      { name: 'Deep sub 808', vibe: 'deep 808 sub bass, hip hop, long decay' },
      { name: 'Synthwave', vibe: 'smooth analog synthwave bass, retro 80s glide' },
      { name: 'Reese', vibe: 'detuned reese bass, growling and wide, drum and bass' },
      { name: 'Acid squelch', vibe: 'squelchy acid 303 bass, resonant filter sweep' },
    ]},
    { category: 'Acoustic', sounds: [
      { name: 'Smoky jazz upright', vibe: 'smoky jazz upright bass, woody tone, brushed feel' },
      { name: 'Rockabilly slap', vibe: 'slapped rockabilly upright bass, percussive and bouncy' },
    ]},
    { category: 'Dirty', sounds: [
      { name: 'Fuzz distortion', vibe: 'gritty fuzz distortion bass, aggressive overdrive' },
      { name: 'Overdriven rock', vibe: 'overdriven rock bass, tube amp grit, midrange bite' },
    ]},
  ],
  guitar: [
    { category: 'Clean', sounds: [
      { name: 'Clean chorus', vibe: 'clean electric guitar, lush chorus, studio recording' },
      { name: 'Surf twang', vibe: 'twangy surf guitar, dripping spring reverb' },
      { name: 'Funk strat', vibe: 'tight funk strat, bright single-coil, percussive muted chords' },
    ]},
    { category: 'Driven', sounds: [
      { name: 'Crunchy tube', vibe: 'crunchy tube amp electric guitar, warm breakup' },
      { name: 'High-gain metal', vibe: 'high gain metal rhythm guitar, tight palm-muted chug' },
      { name: 'Blues lead', vibe: 'singing blues lead guitar, creamy overdrive, sustained bends' },
    ]},
    { category: 'Acoustic', sounds: [
      { name: 'Fingerpicked steel', vibe: 'fingerpicked steel-string acoustic guitar, intimate close mic' },
      { name: 'Strummed dreadnought', vibe: 'strummed dreadnought acoustic guitar, full and bright' },
      { name: 'Nylon classical', vibe: 'nylon-string classical guitar, warm and mellow' },
    ]},
    { category: 'Ambient', sounds: [
      { name: 'Shimmer', vibe: 'ambient shimmer guitar, long reverb tails, ethereal' },
      { name: 'Tremolo haze', vibe: 'hazy tremolo guitar, slow wobble, dreamy reverb' },
    ]},
  ],
  keys: [
    { category: 'Piano', sounds: [
      { name: 'Intimate grand', vibe: 'intimate felt grand piano, close mic, soft pedal' },
      { name: 'Bright concert', vibe: 'bright concert grand piano, open and resonant' },
      { name: 'Honky-tonk', vibe: 'honky-tonk upright piano, saloon character, slightly detuned' },
    ]},
    { category: 'Electric', sounds: [
      { name: 'Dusty Rhodes', vibe: 'dusty Rhodes electric piano, gentle tremolo, lo-fi warmth' },
      { name: 'Wurlitzer bark', vibe: 'barking Wurlitzer electric piano, gritty and funky' },
      { name: 'FM glass', vibe: 'glassy FM electric piano, crystalline 80s bells' },
    ]},
    { category: 'Organ', sounds: [
      { name: 'Rotary Hammond', vibe: 'Hammond organ through a rotary speaker, gospel drive' },
      { name: 'Cathedral pipe', vibe: 'grand cathedral pipe organ, vast and solemn' },
    ]},
    { category: 'Synth', sounds: [
      { name: 'Warm analog pad', vibe: 'warm analog synth pad, slow attack, enveloping' },
      { name: 'Glass bells', vibe: 'glassy FM bell keys, dreamy and crystalline' },
    ]},
  ],
  lead: [
    { category: 'Guitar', sounds: [
      { name: 'Singing lead', vibe: 'singing lead electric guitar, sustained bends, creamy overdrive' },
      { name: 'Shred', vibe: 'fast shred lead guitar, high gain, tapping and legato' },
    ]},
    { category: 'Synth', sounds: [
      { name: 'Fat analog', vibe: 'fat analog synth lead, portamento, retro' },
      { name: 'Supersaw', vibe: 'bright supersaw lead, wide and anthemic, trance' },
      { name: 'Pluck', vibe: 'plucky synth lead, short and bouncy, arpeggiated' },
    ]},
    { category: 'Acoustic', sounds: [
      { name: 'Breathy flute', vibe: 'breathy wooden flute lead, airy and warm' },
      { name: 'Muted trumpet', vibe: 'soulful muted trumpet lead, late-night jazz' },
      { name: 'Violin', vibe: 'expressive solo violin lead, singing vibrato' },
    ]},
    { category: 'Vintage', sounds: [
      { name: 'Eerie theremin', vibe: 'eerie theremin lead, wide vibrato, vintage sci-fi' },
      { name: 'Whistle', vibe: 'clear whistle lead, pure and simple, folk' },
    ]},
  ],
}

// Flat [{name, vibe}] for a part, for search and quick access.
export function allSounds(part) {
  return (SOUND_LIBRARY[part] || []).flatMap((c) => c.sounds)
}
