import { Midi } from '@tonejs/midi'

/**
 * Parse a MIDI file (ArrayBuffer or URL) into the track format
 * used by PianoRoll and TrackMixer.
 *
 * Returns: {
 *   tempo: number,
 *   duration: number,
 *   tracks: [{ name, program, notes: [{ pitch, start, end, velocity }] }]
 * }
 */
export async function parseMidiFile(source) {
  let midi

  if (source instanceof ArrayBuffer) {
    midi = new Midi(source)
  } else if (typeof source === 'string') {
    const response = await fetch(source)
    const buffer = await response.arrayBuffer()
    midi = new Midi(buffer)
  } else {
    throw new Error('Source must be an ArrayBuffer or URL string')
  }

  const tempo = midi.header.tempos.length > 0
    ? Math.round(midi.header.tempos[0].bpm)
    : 120

  const tracks = midi.tracks
    .filter((track) => track.notes.length > 0)
    .map((track) => ({
      name: track.name || `${track.instrument.name}`,
      program: track.instrument.number,
      channel: track.channel,
      isDrum: track.channel === 9,
      notes: track.notes.map((note) => ({
        pitch: note.midi,
        start: note.time,
        end: note.time + note.duration,
        velocity: Math.round(note.velocity * 127),
        name: note.name,
      })),
    }))

  const duration = tracks.reduce((max, track) => {
    const trackMax = track.notes.reduce((m, n) => Math.max(m, n.end), 0)
    return Math.max(max, trackMax)
  }, 0)

  return { tempo, duration, tracks }
}

/**
 * Parse a MIDI file from a File/Blob object (e.g., from file input or drag-drop)
 */
export async function parseMidiBlob(blob) {
  const buffer = await blob.arrayBuffer()
  return parseMidiFile(buffer)
}
