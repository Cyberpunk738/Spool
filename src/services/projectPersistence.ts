import type { TimelineClip } from '../domain/timeline'

export interface PersistedAsset {
  id: string
  name: string
  type: string
  lastModified: number
  blob: Blob
}

export interface PersistedProject {
  schemaVersion: 1
  assets: PersistedAsset[]
  clips: TimelineClip[]
  preset: 'landscape' | 'portrait' | 'square'
  background: string
  textOverlay?: {
    id: string
    text: string
    start: number
    end: number
    x: number
    y: number
    fontSize: number
    colour: string
    background: string
  }
  music?: { name: string; type: string; lastModified: number; blob: Blob; gain: number; offset: number }
  sourceGain?: number
  updatedAt: string
}

const DATABASE = 'spool-projects'
const STORE = 'projects'
const PROJECT_KEY = 'current'

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1)
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE)) request.result.createObjectStore(STORE)
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(request.error ?? new Error('Could not open local project storage.'))
  })
}

export async function saveProject(project: PersistedProject): Promise<void> {
  const database = await openDatabase()
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readwrite')
      transaction.objectStore(STORE).put(project, PROJECT_KEY)
      transaction.oncomplete = () => resolve()
      transaction.onerror = () => reject(transaction.error ?? new Error('Local project save failed.'))
      transaction.onabort = () => reject(transaction.error ?? new Error('Local project save was interrupted.'))
    })
  } finally {
    database.close()
  }
}

export async function loadProject(): Promise<PersistedProject | null> {
  const database = await openDatabase()
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(STORE, 'readonly')
      const request = transaction.objectStore(STORE).get(PROJECT_KEY)
      request.onsuccess = () => {
        const value = request.result as PersistedProject | undefined
        resolve(value?.schemaVersion === 1 ? value : null)
      }
      request.onerror = () => reject(request.error ?? new Error('Local project restore failed.'))
    })
  } finally {
    database.close()
  }
}
