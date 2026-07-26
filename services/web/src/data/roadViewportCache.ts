import type { MapBounds, MapRoadPage } from '../api/contracts'

type StoredViewport = {
  key: string
  bounds: MapBounds
  page: MapRoadPage
  storedAt: number
}

const DATABASE_NAME = 'yukisaki-web-road-cache'
const DATABASE_VERSION = 1
const STORE_NAME = 'viewports'
const MAX_ENTRIES = 12
const MAX_AGE_MS = 24 * 60 * 60_000

function openDatabase(): Promise<IDBDatabase | undefined> {
  if (!('indexedDB' in window)) return Promise.resolve(undefined)
  return new Promise((resolve) => {
    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION)
    request.onupgradeneeded = () => {
      const database = request.result
      if (!database.objectStoreNames.contains(STORE_NAME)) {
        database.createObjectStore(STORE_NAME, { keyPath: 'key' })
      }
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => resolve(undefined)
    request.onblocked = () => resolve(undefined)
  })
}

function allEntries(database: IDBDatabase): Promise<StoredViewport[]> {
  return new Promise((resolve) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).getAll()
    request.onsuccess = () => resolve(request.result as StoredViewport[])
    request.onerror = () => resolve([])
  })
}

function transactionComplete(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve) => {
    transaction.oncomplete = () => resolve()
    transaction.onerror = () => resolve()
    transaction.onabort = () => resolve()
  })
}

function containsBounds(container: MapBounds, requested: MapBounds): boolean {
  return container.minLongitude <= requested.minLongitude
    && container.minLatitude <= requested.minLatitude
    && container.maxLongitude >= requested.maxLongitude
    && container.maxLatitude >= requested.maxLatitude
}

function boundsArea(bounds: MapBounds): number {
  return (bounds.maxLongitude - bounds.minLongitude) * (bounds.maxLatitude - bounds.minLatitude)
}

function cacheKey(bounds: MapBounds): string {
  return [
    bounds.minLongitude,
    bounds.minLatitude,
    bounds.maxLongitude,
    bounds.maxLatitude,
  ].map((value) => value.toFixed(5)).join(',')
}

export async function loadRoadViewport(bounds: MapBounds): Promise<StoredViewport | undefined> {
  const database = await openDatabase()
  if (!database) return undefined
  try {
    const now = Date.now()
    return (await allEntries(database))
      .filter((entry) => now - entry.storedAt <= MAX_AGE_MS && containsBounds(entry.bounds, bounds))
      .sort((left, right) => boundsArea(left.bounds) - boundsArea(right.bounds))[0]
  } finally {
    database.close()
  }
}

export async function saveRoadViewport(bounds: MapBounds, page: MapRoadPage): Promise<void> {
  const database = await openDatabase()
  if (!database) return
  try {
    const entries = await allEntries(database)
    const now = Date.now()
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    const store = transaction.objectStore(STORE_NAME)
    store.put({ key: cacheKey(bounds), bounds, page, storedAt: now } satisfies StoredViewport)
    entries
      .filter((entry) => now - entry.storedAt > MAX_AGE_MS)
      .forEach((entry) => store.delete(entry.key))
    entries
      .filter((entry) => now - entry.storedAt <= MAX_AGE_MS)
      .sort((left, right) => right.storedAt - left.storedAt)
      .slice(MAX_ENTRIES - 1)
      .forEach((entry) => store.delete(entry.key))
    await transactionComplete(transaction)
  } finally {
    database.close()
  }
}

export async function clearRoadViewportCache(): Promise<void> {
  const database = await openDatabase()
  if (!database) return
  try {
    const transaction = database.transaction(STORE_NAME, 'readwrite')
    transaction.objectStore(STORE_NAME).clear()
    await transactionComplete(transaction)
  } finally {
    database.close()
  }
}
