import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import clsx from 'clsx'
import { MicrophoneIcon, StopIcon } from '@heroicons/react/20/solid'
import { Button } from '@/components/catalyst/button'
import { useStudio } from '@/lib/studio/StudioContext'
import { engine } from '@/lib/studio/engine'
import { openMic, listInputs, startCapture, measureLatency, toBuffer } from '@/lib/studio/capture'
import { sectionRanges, updateTrack, makeTrack, trackById, BEATS_PER_BAR } from '@/lib/studio/project'
import { INSTRUMENTS } from './RiffPage'
import { Callout, Pill, Toggle, Wave, panel, outlineBtn } from '@/components/voxmidi/studio/ui'

const COUNT_INS = [1, 2, 4]

// ── Latency dialog ─────────────────────────────────────────────────────────────

function LatencyDialog({ latency, onMeasure, onClose }) {
  const [state, setState] = useState('idle') // idle | running | failed
  async function run() {
    setState('running')
    const ms = await onMeasure()
    setState(ms == null ? 'failed' : 'idle')
  }
  return (
    <div onClick={onClose} className="fixed inset-0 z-[60] grid place-items-center p-6 bg-zinc-950/70 backdrop-blur-[2px]">
      <div onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" className="w-[440px] max-w-full rounded-xl border border-zinc-200 dark:border-zinc-800 bg-white dark:bg-zinc-900 shadow-xl p-6">
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-white">Let's measure your delay</h2>
        <p className="mt-2 text-sm text-zinc-500 dark:text-zinc-400">
          Hold your mic near your speakers and turn them up. We'll play five clicks, time how long each takes to come back, then line your takes up by that much.
        </p>
        <div className="my-5 rounded-lg bg-canvas border border-zinc-200 dark:border-zinc-800 p-5 text-center">
          <div className={clsx('font-mono tabular-nums text-[2rem] font-semibold', state === 'running' && 'animate-pulse', latency == null ? 'text-zinc-600' : 'text-emerald-400')}>
            {state === 'running' ? '...' : latency == null ? '- ms' : `${latency} ms`}
          </div>
          <div className="mt-1.5 text-xs text-zinc-400 dark:text-zinc-500">
            {state === 'running' ? 'Listening for the clicks...'
              : state === 'failed' ? "Didn't hear the clicks. Turn the speakers up or move the mic closer, then try again."
              : latency == null ? 'Round-trip delay' : "We'll shift every take back by this much"}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <Button plain onClick={onClose}>{latency == null ? 'Skip for now' : 'Done'}</Button>
          <div className="flex-1" />
          <Button color="indigo" onClick={run} disabled={state === 'running'}>{latency == null ? 'Measure' : 'Measure again'}</Button>
        </div>
      </div>
    </div>
  )
}

// ── Main page ──────────────────────────────────────────────────────────────────

export default function RecordPage() {
  const navigate = useNavigate()
  const { project, setProject, selSection, setSelSection, takes, addTake, latency, setLatency, toast } = useStudio()

  const [devices, setDevices] = useState([])
  const [deviceId, setDeviceId] = useState('')
  const [micError, setMicError] = useState('')
  const [countIn, setCountIn] = useState(1)
  const [monitor, setMonitor] = useState(false)
  const [tempo, setTempo] = useState(project?.tempo ?? 100)
  const [recording, setRecording] = useState(false)
  const [takeSel, setTakeSel] = useState(null)
  const [dest, setDest] = useState('guitar')
  const [instrument, setInstrument] = useState('harmonic')
  const [showLatency, setShowLatency] = useState(false)
  const [clickOn, setClickOn] = useState(true)

  const mic = useRef(null) // { stream, source, analyser, monGain }
  const rec = useRef(null) // { cap, downbeat, startBeat, clickTimer }
  const level = useRef(null)
  const levelText = useRef(null)
  const timer = useRef(null)
  const raf = useRef(0)

  const bpm = project?.tempo ?? tempo
  const startBeat = project ? sectionRanges(project.sections)[selSection]?.start ?? 0 : 0

  useEffect(() => {
    if (takeSel == null && takes.length) setTakeSel(takes[takes.length - 1].id)
  }, [takes, takeSel])

  // Release the mic when leaving the page
  useEffect(() => () => {
    cancelAnimationFrame(raf.current)
    clearInterval(rec.current?.clickTimer)
    mic.current?.stream.getTracks().forEach((t) => t.stop())
    engine.stop()
  }, [])

  function meter() {
    const an = mic.current?.analyser
    if (!an) return
    const buf = new Float32Array(an.fftSize)
    an.getFloatTimeDomainData(buf)
    let peak = 0
    for (const s of buf) peak = Math.max(peak, Math.abs(s))
    if (level.current) {
      level.current.style.width = `${Math.min(100, peak * 120)}%`
      level.current.style.background = peak > 0.9 ? 'var(--red-500)' : peak > 0.7 ? 'var(--amber-500)' : 'var(--emerald-500)'
    }
    if (levelText.current) levelText.current.textContent = peak < 0.001 ? '−∞ dB' : `${(20 * Math.log10(peak)).toFixed(1)} dB`
    raf.current = requestAnimationFrame(meter)
  }

  async function ensureMic(id = deviceId) {
    if (mic.current) return true
    try {
      const ctx = engine.context()
      const stream = await openMic(id)
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 1024
      source.connect(analyser)
      const monGain = ctx.createGain()
      monGain.gain.value = monitor ? 0.8 : 0
      source.connect(monGain)
      monGain.connect(engine.master)
      mic.current = { stream, source, analyser, monGain }
      const inputs = await listInputs()
      setDevices(inputs)
      if (!id) setDeviceId(stream.getAudioTracks()[0]?.getSettings().deviceId || inputs[0]?.id || '')
      setMicError('')
      cancelAnimationFrame(raf.current)
      meter()
      return true
    } catch {
      setMicError("Can't reach your microphone. Check the browser's mic permission and try again.")
      return false
    }
  }

  async function changeDevice(id) {
    setDeviceId(id)
    mic.current?.stream.getTracks().forEach((t) => t.stop())
    mic.current = null
    await ensureMic(id)
  }

  function toggleMonitor(v) {
    setMonitor(v)
    if (mic.current) mic.current.monGain.gain.value = v ? 0.8 : 0
  }

  async function startRecording() {
    if (!(await ensureMic())) return
    const ctx = engine.context()
    const spb = 60 / bpm
    const t0 = ctx.currentTime + 0.15
    const downbeat = t0 + countIn * BEATS_PER_BAR * spb
    for (let i = 0; i < countIn * BEATS_PER_BAR; i++) engine.click(t0 + i * spb, i % 4 === 0)
    const cap = await startCapture(ctx, mic.current.source)
    let clickTimer = null
    if (project) {
      engine.play(project, { from: startBeat, at: downbeat - 0.06, metronome: clickOn })
    } else {
      // No song yet: keep the click going after the count-in
      let next = downbeat
      let beat = 0
      clickTimer = setInterval(() => {
        while (next < ctx.currentTime + 0.3) { engine.click(next, beat % 4 === 0); next += spb; beat++ }
      }, 50)
    }
    rec.current = { cap, downbeat, clickTimer }
    setRecording(true)
    const tick = () => {
      if (!rec.current) return
      const s = ctx.currentTime - downbeat
      if (timer.current) timer.current.textContent = s < 0 ? `count-in ${Math.ceil(-s / spb)}` : `${s.toFixed(1)}s · take ${takes.length + 1}`
      requestAnimationFrame(tick)
    }
    tick()
  }

  async function stopRecording() {
    const r = rec.current
    rec.current = null
    setRecording(false)
    clearInterval(r.clickTimer)
    engine.stop()
    const ctx = engine.context()
    const { samples, startTime, sampleRate } = r.cap.stop()
    // Sound that reached the mic at downbeat + latency was played on the downbeat
    const from = Math.max(0, Math.round((r.downbeat + (latency || 0) / 1000 - startTime) * sampleRate))
    const take = samples.subarray(from)
    if (take.length < sampleRate * 0.5) {
      toast('That take was under half a second. Nothing saved.')
      return
    }
    const meta = await addTake(toBuffer(ctx, take, sampleRate), { startBeat: project ? startBeat : 0, tempo: bpm, latency: latency || 0, instrument, name: `${INSTRUMENTS.find((i) => i.id === instrument).label} ${takes.length + 1}` })
    setTakeSel(meta.id)
    toast('Take captured')
  }

  async function runLatency() {
    if (!(await ensureMic())) return null
    const ms = await measureLatency(engine.context(), mic.current.source)
    if (ms != null) setLatency(ms)
    return ms
  }

  function useTake() {
    const take = takes.find((t) => t.id === takeSel)
    if (!take) { toast('Record a take first'); return }
    if (!project) {
      navigate(`/riff?take=${take.id}&kind=${take.instrument || instrument}`)
      return
    }
    const clip = { id: `c${Date.now().toString(36)}`, takeId: take.id, startBeat: take.startBeat ?? startBeat, offset: 0, duration: take.duration }
    // A destination that was deleted since falls back to a new track
    const target = dest !== '__new' && !trackById(project, dest) ? '__new' : dest
    let destName = trackById(project, target)?.name
    setProject((p) => {
      let next = p
      let id = target
      if (target === '__new') {
        const t = { ...makeTrack(p, 'audio'), name: take.name }
        next = { ...next, tracks: [...next.tracks, t] }
        id = t.id
        destName = t.name
      }
      return updateTrack(next, id, (t) => ({ clips: [...(t.clips || []), clip] }))
    }, { what: `Placed ${take.name} on ${destName || 'a new track'}` })
    toast(`${take.name} placed on ${destName || 'a new track'}`)
    navigate('/song')
  }

  const sectionName = project?.sections[selSection]?.kind

  return (
    <div className="max-w-3xl mx-auto px-4 py-8 space-y-5">

      {/* Page header */}
      <div>
        <h1 className="text-2xl font-bold text-zinc-900 dark:text-white">Record</h1>
        <p className="text-sm text-zinc-500 dark:text-zinc-400 mt-1">
          Play along with the click. Your take stays audio. Nothing gets transcribed unless you ask.
        </p>
        {project && (
          <p className="text-xs text-zinc-400 dark:text-zinc-500 mt-1">
            The song plays while you record. Wear headphones so it doesn't bleed into your take.
          </p>
        )}
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-xs text-zinc-500 dark:text-zinc-400">What are you recording?</span>
        {INSTRUMENTS.map((i) => <Pill key={i.id} on={instrument === i.id} onClick={() => { setInstrument(i.id); if (project) setDest(i.id === 'vocals' ? 'vocals' : i.id === 'harmonic' ? 'guitar' : '__new') }}>{i.label}</Pill>)}
      </div>

      {micError && (
        <Callout title={micError}>
          {project ? 'Your song is untouched. You can keep editing the AI parts while you sort it out.' : 'Nothing was recorded.'}
        </Callout>
      )}

      <div className="grid grid-cols-1 md:grid-cols-[1fr_240px] gap-4">
        <section className={clsx(panel, 'p-5 flex flex-col gap-4')}>
          <div className="flex flex-col gap-1.5">
            <label className="text-xs text-zinc-500 dark:text-zinc-400">Input</label>
            <select
              value={deviceId}
              onChange={(e) => changeDevice(e.target.value)}
              onFocus={() => ensureMic()}
              className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1.5 text-sm text-zinc-900 dark:text-white"
            >
              {devices.length ? devices.map((d) => <option key={d.id} value={d.id}>{d.label}</option>)
                : <option value="">Default input. Allow mic access to list devices</option>}
            </select>
          </div>

          <div className="flex flex-col gap-2">
            <div className="flex items-baseline justify-between">
              <label className="text-xs text-zinc-500 dark:text-zinc-400">Level</label>
              <span ref={levelText} className="font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">−∞ dB</span>
            </div>
            <div className="relative h-2.5 rounded-full bg-zinc-200 dark:bg-zinc-800 overflow-hidden">
              <div ref={level} className="h-full w-0 bg-emerald-500 transition-[width] duration-75" />
              <div className="absolute top-0 bottom-0 left-[82%] w-px bg-amber-500" />
            </div>
          </div>

          <div className="flex flex-wrap gap-5">
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-zinc-500 dark:text-zinc-400">Count-in</label>
              <div className="flex gap-1">
                {COUNT_INS.map((c) => (
                  <Pill key={c} on={countIn === c} onClick={() => setCountIn(c)} className="font-mono text-xs">{c} bar{c > 1 ? 's' : ''}</Pill>
                ))}
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-zinc-500 dark:text-zinc-400">Monitoring</label>
              <div className="flex items-center gap-2">
                <Toggle on={monitor} onChange={toggleMonitor} label="Monitoring" />
                <span className="text-xs text-zinc-400 dark:text-zinc-500">{monitor ? "On. You'll hear yourself" : 'Off'}</span>
              </div>
            </div>
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-zinc-500 dark:text-zinc-400">Latency</label>
              <button type="button" onClick={() => setShowLatency(true)} className={clsx(outlineBtn, 'font-mono')}>
                {latency == null ? 'Not measured' : `${latency} ms`}
              </button>
            </div>
            {project && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-zinc-500 dark:text-zinc-400">Start from</label>
                <select value={selSection} disabled={recording} onChange={(e) => setSelSection(Number(e.target.value))}
                  className="rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-sm text-zinc-900 dark:text-white">
                  {project.sections.map((s, i) => <option key={s.id} value={i}>{s.kind} · bar {sectionRanges(project.sections)[i].start / BEATS_PER_BAR + 1}</option>)}
                </select>
              </div>
            )}
            {project && (
              <div className="flex flex-col gap-1.5">
                <label className="text-xs text-zinc-500 dark:text-zinc-400">Click</label>
                <div className="flex items-center gap-2 py-1">
                  <Toggle on={clickOn} onChange={setClickOn} label="Click while recording" />
                  <span className="text-xs text-zinc-400 dark:text-zinc-500">{clickOn ? 'On' : 'Song only'}</span>
                </div>
              </div>
            )}
            <div className="flex flex-col gap-1.5">
              <label className="text-xs text-zinc-500 dark:text-zinc-400">Tempo</label>
              {project ? (
                <span className="py-1.5 font-mono tabular-nums text-sm text-zinc-700 dark:text-zinc-300">{bpm} BPM</span>
              ) : (
                <div className="flex items-center gap-1.5">
                  <input type="number" min={40} max={240} value={tempo} onChange={(e) => { const v = e.target.valueAsNumber; if (v >= 40 && v <= 240) setTempo(v) }}
                    className="w-16 rounded-lg border border-zinc-200 dark:border-zinc-700 bg-white dark:bg-zinc-800 px-2 py-1 text-center font-mono tabular-nums text-sm text-zinc-900 dark:text-white" />
                  <span className="text-xs text-zinc-500">BPM</span>
                </div>
              )}
            </div>
          </div>

          <div className="flex items-center gap-3 pt-1">
            <button
              type="button"
              onClick={recording ? stopRecording : startRecording}
              aria-label={recording ? 'Stop recording' : 'Record'}
              className={clsx('flex items-center justify-center size-14 rounded-full text-white shadow-sm transition active:scale-95', recording ? 'bg-red-600 animate-pulse' : 'bg-red-600 hover:bg-red-500')}
            >
              {recording ? <StopIcon className="size-6" /> : <MicrophoneIcon className="size-6" />}
            </button>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-medium text-zinc-900 dark:text-white">{recording ? 'Recording' : 'Arm and record'}</span>
              <span ref={timer} className="font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">
                {recording ? '' : `${countIn} bar count-in at ${bpm} BPM${project ? ` · plays from the ${sectionName}` : ''}`}
              </span>
            </div>
          </div>
        </section>

        <section className={clsx(panel, 'p-4 flex flex-col gap-2.5')}>
          <div className="flex items-center justify-between">
            <span className="text-sm font-semibold text-zinc-900 dark:text-white">Takes</span>
            <span className="font-mono tabular-nums text-xs text-zinc-400 dark:text-zinc-500">{takes.length} saved</span>
          </div>
          <div className="flex flex-col gap-2 max-h-80 overflow-y-auto">
            {takes.map((t) => {
              const on = t.id === takeSel
              return (
                <button key={t.id} type="button" onClick={() => setTakeSel(t.id)}
                  className={clsx('w-full text-left rounded-lg border px-2.5 py-2', on ? 'border-emerald-800 bg-emerald-500/10' : 'border-zinc-200 dark:border-zinc-800 bg-zinc-50 dark:bg-zinc-950/60')}>
                  <div className="flex items-center gap-2">
                    <span className={clsx('size-2 rounded-full', on ? 'bg-emerald-500' : 'bg-zinc-600')} />
                    <span className="text-xs text-zinc-900 dark:text-white">{t.name}</span>
                    <span className="ml-auto font-mono tabular-nums text-[10px] text-zinc-400 dark:text-zinc-500">{t.duration.toFixed(1)}s</span>
                  </div>
                  <Wave peaks={t.peaks} stroke={on ? 'var(--emerald-400)' : 'var(--zinc-600)'} className="mt-1.5" />
                </button>
              )
            })}
          </div>
          {takes.length === 0 && (
            <div className="rounded-lg border-2 border-dashed border-zinc-300 dark:border-zinc-700 p-3 text-xs text-zinc-400 dark:text-zinc-500">
              No takes yet. Hit record and play four bars.
            </div>
          )}
          {project && takes.length > 0 && (
            <label className="flex items-center gap-2 text-xs text-zinc-500 dark:text-zinc-400 mt-auto">
              Put it on
              <select value={dest} onChange={(e) => setDest(e.target.value)} className="rounded-md border border-zinc-300 dark:border-zinc-700 bg-zinc-50 dark:bg-zinc-800 px-1.5 py-1 text-xs text-zinc-900 dark:text-white">
                {project.tracks.filter((t) => t.kind === 'audio' && t.id !== 'drumsai').map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                <option value="__new">New audio track</option>
              </select>
            </label>
          )}
          <Button color="emerald" className={clsx(!project || takes.length === 0 ? 'mt-auto' : '')} disabled={!takeSel || recording} onClick={useTake}>
            {project ? 'Use this take' : 'Build a song from this take'}
          </Button>
          {project && takeSel && !recording && (
            <button type="button" onClick={() => navigate(`/riff?take=${takeSel}`)} className="text-xs text-zinc-400 hover:text-indigo-300 transition">
              Or build a new song from this take
            </button>
          )}
        </section>
      </div>

      {showLatency && <LatencyDialog latency={latency} onMeasure={runLatency} onClose={() => setShowLatency(false)} />}
    </div>
  )
}
