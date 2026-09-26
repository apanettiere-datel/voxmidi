// File output for the studio: WAV encoding, per-track MIDI, and a small
// store-only ZIP writer so an export is one download instead of many.

import { Midi } from '@tonejs/midi'
import { performedNotes } from './engine'

const PPQ = 480

// GM programs per studio sound
const PROGRAMS = {
  'Warm bass': 33, 'Sub 808': 38, 'Picked bass': 34, 'Round synth': 39,
  'Felt piano': 0, 'Rhodes': 4, 'Soft pad': 89, 'Plucked keys': 6,
  'Bell lead': 9, 'Breath synth': 81,
}

// MIDI for one track. Times and velocities are exactly what plays in the app:
// swing, humanize, rolls and flams are baked in, nothing is re-quantized.
export function trackMidi(project, track) {
  const midi = new Midi()
  midi.header.setTempo(project.tempo)
  midi.header.timeSignatures.push({ ticks: 0, timeSignature: [4, 4] })
  midi.header.name = project.name
  const t = midi.addTrack()
  t.name = track.name
  if (track.id === 'drums') t.channel = 9
  else t.instrument.number = PROGRAMS[track.sound] ?? 0
  for (const n of performedNotes(project, track)) {
    t.addNote({
      midi: n.p,
      ticks: Math.round(n.t * PPQ),
      durationTicks: Math.max(1, Math.round(n.d * PPQ)),
      velocity: n.v / 127,
    })
  }
  return new Uint8Array(midi.toArray())
}

export function wavBytes(buffer) {
  const ch = buffer.numberOfChannels
  const len = buffer.length
  const sr = buffer.sampleRate
  const out = new DataView(new ArrayBuffer(44 + len * ch * 2))
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)) }
  str(0, 'RIFF'); out.setUint32(4, 36 + len * ch * 2, true); str(8, 'WAVE')
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true)
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true)
  str(36, 'data'); out.setUint32(40, len * ch * 2, true)
  const data = Array.from({ length: ch }, (_, c) => buffer.getChannelData(c))
  let o = 44
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < ch; c++) {
      const s = Math.max(-1, Math.min(1, data[c][i]))
      out.setInt16(o, s < 0 ? s * 0x8000 : s * 0x7fff, true)
      o += 2
    }
  }
  return new Uint8Array(out.buffer)
}

export function wavSize(seconds, channels = 2, sampleRate = 44100) {
  return 44 + Math.ceil(seconds * sampleRate) * channels * 2
}

// Slice [offset, offset + duration) seconds out of a buffer
export function sliceBuffer(ctx, buffer, offset, duration) {
  const sr = buffer.sampleRate
  const a = Math.max(0, Math.floor(offset * sr))
  const b = Math.min(buffer.length, a + Math.floor(duration * sr))
  const out = ctx.createBuffer(buffer.numberOfChannels, Math.max(1, b - a), sr)
  for (let c = 0; c < buffer.numberOfChannels; c++) out.copyToChannel(buffer.getChannelData(c).subarray(a, b), c)
  return out
}

// ─── ZIP (store only, no compression) ────────────────────────────────────────

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(bytes) {
  let c = 0xffffffff
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

// files: [{ name, bytes: Uint8Array }]
export function zip(files) {
  const enc = new TextEncoder()
  const parts = []
  const central = []
  let offset = 0
  for (const f of files) {
    const name = enc.encode(f.name)
    const crc = crc32(f.bytes)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true)
    local.setUint32(14, crc, true); local.setUint32(18, f.bytes.length, true); local.setUint32(22, f.bytes.length, true)
    local.setUint16(26, name.length, true)
    parts.push(new Uint8Array(local.buffer), name, f.bytes)
    const cen = new DataView(new ArrayBuffer(46))
    cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true)
    cen.setUint32(16, crc, true); cen.setUint32(20, f.bytes.length, true); cen.setUint32(24, f.bytes.length, true)
    cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true)
    central.push(new Uint8Array(cen.buffer), name)
    offset += 30 + name.length + f.bytes.length
  }
  const cenSize = central.reduce((a, p) => a + p.length, 0)
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true)
  end.setUint32(12, cenSize, true); end.setUint32(16, offset, true)
  return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' })
}

export function download(blob, filename) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 5000)
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}
