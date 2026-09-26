// Tests for the timeline edit operations. Run: node frontend/src/lib/studio/edit.test.mjs
import assert from 'node:assert/strict'
import { splitClip, clearRange, copyRange, pasteInto, splitAt, trimClip, clipEnd, snapTo } from './edit.js'

const SPB = 0.5 // 120 BPM
const near = (a, b, msg) => assert.ok(Math.abs(a - b) < 1e-6, `${msg}: ${a} != ${b}`)
const midi = (notes) => ({ id: 'bass', kind: 'midi', notes })
const audio = (clips) => ({ id: 'vox', kind: 'audio', notes: [], clips })
// A 4-beat clip at beat 8 that starts 1 s into its take
const clip = { id: 'c1', takeId: 't', startBeat: 8, offset: 1, duration: 2 }

// splitClip keeps audio continuous across the cut
{
  const [a, b] = splitClip(clip, 10, SPB)
  near(a.duration, 1, 'head length'); near(b.startBeat, 10, 'tail start'); near(b.offset, 2, 'tail offset'); near(b.duration, 1, 'tail length')
  assert.deepEqual(splitClip(clip, 8, SPB), [null, clip])
  assert.deepEqual(splitClip(clip, 12, SPB), [clip, null])
}

// clearRange on audio: middle removed, edges kept, untouched clips kept
{
  const other = { ...clip, id: 'c2', startBeat: 20 }
  const t = clearRange(audio([clip, other]), 9, 11, SPB)
  assert.equal(t.clips.length, 3)
  const [a, b, c] = t.clips.sort((x, y) => x.startBeat - y.startBeat)
  near(clipEnd(a, SPB), 9, 'left piece ends at range start')
  near(b.startBeat, 11, 'right piece starts at range end'); near(b.offset, 2.5, 'right piece offset')
  assert.equal(c.id, 'c2')
  assert.equal(clearRange(audio([clip]), 0, 20, SPB).clips.length, 0, 'fully covered clip removed')
}

// clearRange on MIDI: notes inside removed, a note hanging into the range is shortened
{
  const t = clearRange(midi([{ p: 40, t: 0, d: 6, v: 90 }, { p: 41, t: 4, d: 1, v: 90 }, { p: 42, t: 8, d: 1, v: 90 }]), 4, 8, SPB)
  assert.deepEqual(t.notes.map((n) => [n.p, n.t, n.d]), [[40, 0, 4], [42, 8, 1]])
}

// copy then paste round-trips notes to a new place and replaces what was there
{
  const src = midi([{ p: 40, t: 4, d: 1, v: 90 }, { p: 43, t: 6.5, d: 4, v: 80 }, { p: 50, t: 12, d: 1, v: 70 }, { p: 60, t: 13, d: 1, v: 70 }])
  const data = copyRange(src, 4, 8, SPB)
  assert.deepEqual(data.notes.map((n) => [n.p, n.t, n.d]), [[40, 0, 1], [43, 2.5, 1.5]], 'copied notes relative and capped at range end')
  const out = pasteInto(src, data, 12, 4, SPB, 32)
  assert.deepEqual(out.notes.filter((n) => n.t >= 12).map((n) => [n.p, n.t]), [[40, 12], [43, 14.5]], 'old notes in the paste range replaced')
  const tail = pasteInto(src, data, 30, 4, SPB, 32)
  assert.deepEqual(tail.notes.filter((n) => n.t >= 30).map((n) => [n.p, n.t, n.d]), [[40, 30, 1]], 'content past the song end dropped')
}

// copy/paste audio keeps the exact slice of the take
{
  const data = copyRange(audio([clip]), 9, 11, SPB)
  assert.equal(data.clips.length, 1)
  near(data.clips[0].startBeat, 0, 'relative start'); near(data.clips[0].offset, 1.5, 'slice offset'); near(data.clips[0].duration, 1, 'slice length')
  const out = pasteInto(audio([]), data, 20, 2, SPB, 64)
  near(out.clips[0].startBeat, 20, 'pasted start'); near(out.clips[0].offset, 1.5, 'pasted offset')
  assert.equal(pasteInto(midi([]), data, 0, 2, SPB, 64).notes.length, 0, 'audio never pastes into a MIDI track')
}

// splitAt cuts clips and notes crossing the cursor
{
  assert.equal(splitAt(audio([clip]), 10, SPB).clips.length, 2)
  const t = splitAt(midi([{ p: 40, t: 2, d: 4, v: 90 }]), 4, SPB)
  assert.deepEqual(t.notes.map((n) => [n.t, n.d]), [[2, 2], [4, 2]])
}

// trimClip can't reveal audio before the take starts or after it ends
{
  const s = trimClip(clip, 'start', 5, SPB, 10)
  near(s.startBeat, 6, 'start stops where the take begins'); near(s.offset, 0, 'offset at 0'); near(clipEnd(s, SPB), 12, 'end unchanged')
  const s2 = trimClip(clip, 'start', 10, SPB, 10)
  near(s2.startBeat, 10, 'trim start in'); near(s2.offset, 2, 'offset follows'); near(clipEnd(s2, SPB), 12, 'end unchanged')
  const e = trimClip(clip, 'end', 40, SPB, 10)
  near(e.duration, 9, 'end stops at the take end (10 s take, 1 s offset)')
  const e2 = trimClip(clip, 'end', 7, SPB, 10)
  near(e2.duration, 0.125, 'end cannot pass the start (0.25 beat minimum)')
}

assert.equal(snapTo(5.3, 1), 5)
assert.equal(snapTo(5.3, 0.25), 5.25)
assert.equal(snapTo(5.3, 0), 5.3)

console.log('edit.js: all tests passed')
