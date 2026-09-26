// Recorded takes live in IndexedDB as WAV blobs, so a refresh doesn't lose
// them. Project JSON stays in localStorage; audio is too big for it.

const DB = 'voxmidi-studio'
const STORE = 'takes'

let db = null

// One connection, reused
function open() {
  if (!db) {
    db = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1)
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' })
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }).catch((e) => { db = null; throw e })
  }
  return db
}

function tx(mode, fn) {
  return open().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const out = fn(t.objectStore(STORE))
    t.oncomplete = () => resolve(out?.result ?? out)
    t.onerror = () => reject(t.error)
  }))
}

// take: { id, name, blob, duration, peaks, tempo, createdAt }
export function saveTake(take) {
  return tx('readwrite', (s) => s.put(take)).catch(() => null)
}

export function listTakes() {
  return tx('readonly', (s) => s.getAll()).then((all) => (all || []).sort((a, b) => a.createdAt - b.createdAt)).catch(() => [])
}

export function deleteTake(id) {
  return tx('readwrite', (s) => s.delete(id)).catch(() => null)
}

export function peaksOf(buffer, n = 200) {
  const ch = buffer.getChannelData(0)
  const step = Math.max(1, Math.floor(ch.length / n))
  const peaks = []
  for (let i = 0; i < n; i++) {
    let p = 0
    for (let j = 0; j < step; j += 4) {
      const a = Math.abs(ch[i * step + j] || 0)
      if (a > p) p = a
    }
    peaks.push(Math.round(p * 1000) / 1000)
  }
  return peaks
}

