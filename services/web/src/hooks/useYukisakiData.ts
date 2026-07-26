import { useCallback, useEffect, useRef, useState } from 'react'
import { yukisakiApi } from '../api/createYukisakiApi'
import { appConfig } from '../api/config'
import { clearRoadViewportCache, loadRoadViewport, saveRoadViewport } from '../data/roadViewportCache'
import type {
  MapBounds,
  MapDataMeta,
  MapRoadPage,
  RoadCondition,
  RoadSegmentFeatureCollection,
  Snowplow,
  WeatherData,
} from '../api/contracts'

type CachedRoadPage = {
  key: string
  bounds: MapBounds
  page: MapRoadPage
  storedAt: number
  lastUsedAt: number
}

type RoadTile = {
  key: string
  bounds: MapBounds
}

const DETAIL_MAX_SPAN_DEGREES = 0.04
const DETAIL_PAGE_LIMIT = 3_000
const DETAIL_MAX_FEATURES = 18_000
const DETAIL_CACHE_MAX_ENTRIES = 4
const OVERVIEW_CACHE_MAX_ENTRIES = 32
const OVERVIEW_MAX_VISIBLE_TILES = 6
const OVERVIEW_REQUEST_CONCURRENCY = 6
const OVERVIEW_TOTAL_PAGE_LIMIT = 12_000
const OVERVIEW_MIN_TILE_LIMIT = 1_500
const ROAD_CACHE_FRESH_MS = 60_000
const ROAD_CACHE_MAX_AGE_MS = 10 * 60_000
const ROAD_REFRESH_INTERVAL_MS = 60_000
const DETAIL_BOUNDS_PADDING = 0.06
const WEB_MERCATOR_MAX_LATITUDE = 85.05112878

const detailCache: CachedRoadPage[] = []
const overviewTileCache = new Map<string, CachedRoadPage>()

function boundsSpan(bounds: MapBounds): number {
  return Math.max(
    bounds.maxLongitude - bounds.minLongitude,
    bounds.maxLatitude - bounds.minLatitude,
  )
}

function isDetailBounds(bounds: MapBounds): boolean {
  const latitudeSpan = bounds.maxLatitude - bounds.minLatitude
  const longitudeSpan = bounds.maxLongitude - bounds.minLongitude
  return Math.max(latitudeSpan, longitudeSpan) <= DETAIL_MAX_SPAN_DEGREES
}

function expandBounds(bounds: MapBounds, paddingRatio: number): MapBounds {
  const latitudePadding = (bounds.maxLatitude - bounds.minLatitude) * paddingRatio
  const longitudePadding = (bounds.maxLongitude - bounds.minLongitude) * paddingRatio
  return {
    minLongitude: Math.max(-180, bounds.minLongitude - longitudePadding),
    minLatitude: Math.max(-90, bounds.minLatitude - latitudePadding),
    maxLongitude: Math.min(180, bounds.maxLongitude + longitudePadding),
    maxLatitude: Math.min(90, bounds.maxLatitude + latitudePadding),
  }
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

function pruneDetailCache(now: number) {
  for (let index = detailCache.length - 1; index >= 0; index -= 1) {
    if (now - detailCache[index].storedAt > ROAD_CACHE_MAX_AGE_MS) detailCache.splice(index, 1)
  }
}

function findDetailCache(bounds: MapBounds, now: number): CachedRoadPage | undefined {
  pruneDetailCache(now)
  const match = detailCache
    .filter((entry) => containsBounds(entry.bounds, bounds))
    .sort((left, right) => boundsArea(left.bounds) - boundsArea(right.bounds))[0]
  if (match) match.lastUsedAt = now
  return match
}

function cacheDetailPage(bounds: MapBounds, page: MapRoadPage, now: number) {
  const key = boundsKey(bounds)
  const existingIndex = detailCache.findIndex((entry) => entry.key === key)
  if (existingIndex >= 0) detailCache.splice(existingIndex, 1)
  detailCache.push({ key, bounds, page, storedAt: now, lastUsedAt: now })
  while (detailCache.length > DETAIL_CACHE_MAX_ENTRIES) {
    const oldest = detailCache.reduce((candidate, entry) => (
      entry.lastUsedAt < candidate.lastUsedAt ? entry : candidate
    ))
    detailCache.splice(detailCache.indexOf(oldest), 1)
  }
}

function clampLatitude(latitude: number): number {
  return Math.max(-WEB_MERCATOR_MAX_LATITUDE, Math.min(WEB_MERCATOR_MAX_LATITUDE, latitude))
}

function longitudeToTileX(longitude: number, zoom: number): number {
  const tileCount = 2 ** zoom
  return Math.max(0, Math.min(tileCount - 1, Math.floor(((longitude + 180) / 360) * tileCount)))
}

function latitudeToTileY(latitude: number, zoom: number): number {
  const tileCount = 2 ** zoom
  const radians = clampLatitude(latitude) * Math.PI / 180
  const value = (1 - Math.asinh(Math.tan(radians)) / Math.PI) / 2
  return Math.max(0, Math.min(tileCount - 1, Math.floor(value * tileCount)))
}

function tileLatitude(y: number, zoom: number): number {
  const radians = Math.atan(Math.sinh(Math.PI * (1 - 2 * y / (2 ** zoom))))
  return radians * 180 / Math.PI
}

function tileBounds(zoom: number, x: number, y: number): MapBounds {
  const tileCount = 2 ** zoom
  return {
    minLongitude: x / tileCount * 360 - 180,
    minLatitude: tileLatitude(y + 1, zoom),
    maxLongitude: (x + 1) / tileCount * 360 - 180,
    maxLatitude: tileLatitude(y, zoom),
  }
}

function tileRange(bounds: MapBounds, zoom: number) {
  const maxLongitude = Math.max(bounds.minLongitude, bounds.maxLongitude - 1e-9)
  const minLatitude = Math.min(bounds.maxLatitude, bounds.minLatitude + 1e-9)
  const minX = longitudeToTileX(bounds.minLongitude, zoom)
  const maxX = longitudeToTileX(maxLongitude, zoom)
  const minY = latitudeToTileY(bounds.maxLatitude, zoom)
  const maxY = latitudeToTileY(minLatitude, zoom)
  return { minX, maxX, minY, maxY, count: (maxX - minX + 1) * (maxY - minY + 1) }
}

function overviewTiles(bounds: MapBounds): RoadTile[] {
  let zoom = 0
  let range = tileRange(bounds, zoom)
  for (let candidate = 14; candidate >= 0; candidate -= 1) {
    const candidateRange = tileRange(bounds, candidate)
    if (candidateRange.count <= OVERVIEW_MAX_VISIBLE_TILES) {
      zoom = candidate
      range = candidateRange
      break
    }
  }

  const tiles: RoadTile[] = []
  for (let y = range.minY; y <= range.maxY; y += 1) {
    for (let x = range.minX; x <= range.maxX; x += 1) {
      tiles.push({ key: `${zoom}/${x}/${y}`, bounds: tileBounds(zoom, x, y) })
    }
  }
  return tiles
}

function pruneOverviewCache(now: number) {
  overviewTileCache.forEach((entry, key) => {
    if (now - entry.storedAt > ROAD_CACHE_MAX_AGE_MS) overviewTileCache.delete(key)
  })
  while (overviewTileCache.size > OVERVIEW_CACHE_MAX_ENTRIES) {
    const oldest = [...overviewTileCache.values()].reduce((candidate, entry) => (
      entry.lastUsedAt < candidate.lastUsedAt ? entry : candidate
    ))
    overviewTileCache.delete(oldest.key)
  }
}

function boundsKey(bounds: MapBounds): string {
  return [
    bounds.minLongitude,
    bounds.minLatitude,
    bounds.maxLongitude,
    bounds.maxLatitude,
  ].map((value) => value.toFixed(6)).join(',')
}

function mergeRoadPages(pages: MapRoadPage[], complete = false): MapRoadPage | undefined {
  if (!pages.length) return undefined
  const features = new Map<string, RoadSegmentFeatureCollection['features'][number]>()
  const conditions = new Map<string, RoadCondition>()
  pages.forEach((page) => {
    page.roads.features.forEach((feature) => features.set(feature.properties.segment_id, feature))
    page.conditions.forEach((condition) => conditions.set(condition.segmentId, condition))
  })

  const timestamps = pages.map((page) => page.meta.dataTimestamp).filter((value): value is string => Boolean(value))
  const meta: MapDataMeta = {
    schemaVersion: pages[0].meta.schemaVersion,
    dataTimestamp: timestamps.sort().at(-1) ?? null,
    confidence: Math.min(...pages.map((page) => page.meta.confidence)),
    isSimulated: pages.some((page) => page.meta.isSimulated),
    truncated: complete ? false : pages.some((page) => page.meta.truncated || page.nextCursor !== null),
    source: pages.some((page) => page.meta.source === 'mock') ? 'mock' : 'api',
  }
  return {
    roads: { type: 'FeatureCollection', features: [...features.values()] },
    conditions: [...conditions.values()],
    meta,
    nextCursor: null,
  }
}

function splitBounds(bounds: MapBounds): RoadTile[] {
  const middleLongitude = (bounds.minLongitude + bounds.maxLongitude) / 2
  const middleLatitude = (bounds.minLatitude + bounds.maxLatitude) / 2
  return [
    { minLongitude: bounds.minLongitude, minLatitude: bounds.minLatitude, maxLongitude: middleLongitude, maxLatitude: middleLatitude },
    { minLongitude: middleLongitude, minLatitude: bounds.minLatitude, maxLongitude: bounds.maxLongitude, maxLatitude: middleLatitude },
    { minLongitude: bounds.minLongitude, minLatitude: middleLatitude, maxLongitude: middleLongitude, maxLatitude: bounds.maxLatitude },
    { minLongitude: middleLongitude, minLatitude: middleLatitude, maxLongitude: bounds.maxLongitude, maxLatitude: bounds.maxLatitude },
  ].map((tileBoundsValue) => ({ key: `detail:${boundsKey(tileBoundsValue)}`, bounds: tileBoundsValue }))
}

function roadRank(roadType: string | null): number {
  const normalized = (roadType || '')
    .toLowerCase()
    .split(/[;,]/, 1)[0]
    .trim()
    .replace(/_link$/, '')
  if (normalized === 'motorway') return 6
  if (normalized === 'trunk') return 5
  if (normalized === 'primary') return 4
  if (normalized === 'secondary') return 3
  if (normalized === 'tertiary') return 2
  if (normalized === 'unclassified' || normalized === 'residential') return 1
  return 0
}

function minimumRoadRank(span: number): number {
  if (span <= 0.04) return 0
  if (span <= 0.09) return 1
  if (span <= 0.18) return 2
  if (span <= 0.36) return 3
  return 4
}

function filterRoadPage(page: MapRoadPage, span: number): MapRoadPage {
  const minimumRank = minimumRoadRank(span)
  if (minimumRank === 0) return page
  const features = page.roads.features.filter((feature) => roadRank(feature.properties.highway) >= minimumRank)
  const segmentIds = new Set(features.map((feature) => feature.properties.segment_id))
  return {
    ...page,
    roads: { type: 'FeatureCollection', features },
    conditions: page.conditions.filter((condition) => segmentIds.has(condition.segmentId)),
  }
}

function overviewScanPages(span: number): number {
  if (span <= 0.09) return 3
  return 2
}

async function fetchRoadPages(
  bounds: MapBounds,
  signal: AbortSignal,
  maxFeatures: number,
  pageLimit: number,
  onProgress?: (page: MapRoadPage) => void,
): Promise<MapRoadPage> {
  const pages: MapRoadPage[] = []
  let cursor: string | undefined
  let featureCount = 0

  do {
    const remaining = maxFeatures - featureCount
    if (remaining <= 0) break
    const page = await yukisakiApi.getMapRoadPage(
      bounds,
      cursor,
      signal,
      Math.min(pageLimit, remaining),
    )
    pages.push(page)
    featureCount += page.roads.features.length
    cursor = page.nextCursor ?? undefined
    const progress = mergeRoadPages(pages, cursor === undefined)
    if (progress) {
      progress.nextCursor = cursor ?? null
      progress.meta.truncated = cursor !== undefined
      onProgress?.(progress)
    }
  } while (cursor)

  const merged = mergeRoadPages(pages, cursor === undefined)
  if (!merged) {
    throw new Error('道路APIが空のページ集合を返しました。')
  }
  merged.nextCursor = cursor ?? null
  merged.meta.truncated = cursor !== undefined
  return merged
}

function newerPlows(current: Snowplow[], incoming: Snowplow[]): Snowplow[] {
  const currentById = new Map(current.map((plow) => [plow.id, plow]))
  return incoming.map((plow) => {
    const previous = currentById.get(plow.id)
    if (!previous) return plow
    return Date.parse(plow.lastUpdatedAt) >= Date.parse(previous.lastUpdatedAt) ? plow : previous
  })
}

export function useYukisakiData() {
  const [roads, setRoads] = useState<RoadSegmentFeatureCollection>()
  const [conditions, setConditions] = useState<RoadCondition[]>([])
  const [snowplows, setSnowplows] = useState<Snowplow[]>([])
  const [weather, setWeather] = useState<WeatherData>()
  const [meta, setMeta] = useState<MapDataMeta>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [updateStopped, setUpdateStopped] = useState(false)
  const [viewportRefreshing, setViewportRefreshing] = useState(false)
  const [apiOnline, setApiOnline] = useState<boolean>()
  const [reloadKey, setReloadKey] = useState(0)
  const viewportRequestId = useRef(0)
  const viewportAbort = useRef<AbortController | undefined>(undefined)
  const latestBounds = useRef<MapBounds>(appConfig.demo.initialBounds)
  const persistTimer = useRef<number | undefined>(undefined)
  const pendingPersist = useRef<{ bounds: MapBounds; page: MapRoadPage } | undefined>(undefined)

  const applyPage = useCallback((page: MapRoadPage, bounds?: MapBounds) => {
    setRoads(page.roads)
    setConditions(page.conditions)
    setMeta({ ...page.meta, truncated: page.meta.truncated || page.nextCursor !== null })
    if (bounds) {
      pendingPersist.current = { bounds, page }
      if (persistTimer.current) window.clearTimeout(persistTimer.current)
      persistTimer.current = window.setTimeout(() => {
        const pending = pendingPersist.current
        pendingPersist.current = undefined
        persistTimer.current = undefined
        if (pending) void saveRoadViewport(pending.bounds, pending.page)
      }, 350)
    }
  }, [])

  const loadDetailViewport = useCallback(async (
    bounds: MapBounds,
    initial: boolean,
    forceRefresh: boolean,
    requestId: number,
  ) => {
    const now = Date.now()
    const cached = findDetailCache(bounds, now)
    if (cached) applyPage(cached.page, bounds)
    if (cached && !forceRefresh && now - cached.storedAt <= ROAD_CACHE_FRESH_MS) {
      setLoading(false)
      setViewportRefreshing(false)
      return
    }

    const requestBounds = expandBounds(bounds, DETAIL_BOUNDS_PADDING)
    viewportAbort.current?.abort()
    const controller = new AbortController()
    viewportAbort.current = controller
    if (initial && !cached) setLoading(true)
    else if (!cached) setViewportRefreshing(true)

    try {
      const tiles = splitBounds(requestBounds)
      const partialPages = new Map<string, MapRoadPage>()
      const results = await Promise.allSettled(tiles.map(async (tile) => {
        const page = await fetchRoadPages(
          tile.bounds,
          controller.signal,
          Math.floor(DETAIL_MAX_FEATURES / tiles.length),
          DETAIL_PAGE_LIMIT,
          (progress) => {
            if (requestId !== viewportRequestId.current) return
            partialPages.set(tile.key, progress)
            const visible = mergeRoadPages([...partialPages.values()])
            if (visible) applyPage(visible, bounds)
          },
        )
        partialPages.set(tile.key, page)
        return page
      }))
      if (requestId !== viewportRequestId.current) return
      const pages = results
        .filter((result): result is PromiseFulfilledResult<MapRoadPage> => result.status === 'fulfilled')
        .map((result) => result.value)
      const complete = results.every((result) => (
        result.status === 'fulfilled' && result.value.nextCursor === null
      ))
      const page = mergeRoadPages(pages, complete)
      if (!page) throw new Error('道路APIから近距離データを取得できませんでした。')
      cacheDetailPage(requestBounds, page, Date.now())
      applyPage(page, bounds)
      setUpdateStopped(results.some((result) => result.status === 'rejected'))
    } catch {
      if (requestId !== viewportRequestId.current) return
      if (!cached && initial) setError('地図APIから道路データを取得できませんでした。環境が起動中か確認してください。')
      else setUpdateStopped(true)
    } finally {
      if (requestId === viewportRequestId.current) {
        setLoading(false)
        setViewportRefreshing(false)
      }
    }
  }, [applyPage])

  const loadOverviewViewport = useCallback(async (
    bounds: MapBounds,
    initial: boolean,
    forceRefresh: boolean,
    requestId: number,
  ) => {
    const now = Date.now()
    pruneOverviewCache(now)
    const tiles = overviewTiles(bounds)
    const cachedEntries = tiles
      .map((tile) => overviewTileCache.get(tile.key))
      .filter((entry): entry is CachedRoadPage => Boolean(entry))
    cachedEntries.forEach((entry) => { entry.lastUsedAt = now })
    const cachedPage = mergeRoadPages(cachedEntries.map((entry) => entry.page))
    if (cachedPage) applyPage(cachedPage, bounds)

    const tilesToFetch = tiles.filter((tile) => {
      const cached = overviewTileCache.get(tile.key)
      return forceRefresh || !cached || now - cached.storedAt > ROAD_CACHE_FRESH_MS
    })
    if (!tilesToFetch.length) {
      setLoading(false)
      setViewportRefreshing(false)
      return
    }

    viewportAbort.current?.abort()
    const controller = new AbortController()
    viewportAbort.current = controller
    if (initial && !cachedPage) setLoading(true)
    else if (!cachedPage) setViewportRefreshing(true)

    const tileLimit = Math.min(
      DETAIL_PAGE_LIMIT,
      Math.max(
        OVERVIEW_MIN_TILE_LIMIT,
        Math.floor(OVERVIEW_TOTAL_PAGE_LIMIT / tiles.length),
      ),
    )
    const span = boundsSpan(bounds)
    const scanPages = overviewScanPages(span)
    try {
      const results: Array<PromiseSettledResult<{ tile: RoadTile; page: MapRoadPage }>> = []
      for (let index = 0; index < tilesToFetch.length; index += OVERVIEW_REQUEST_CONCURRENCY) {
        const batch = tilesToFetch.slice(index, index + OVERVIEW_REQUEST_CONCURRENCY)
        results.push(...await Promise.allSettled(batch.map(async (tile) => {
          const page = await fetchRoadPages(
            tile.bounds,
            controller.signal,
            tileLimit * scanPages,
            tileLimit,
            (progress) => {
              if (requestId !== viewportRequestId.current) return
              const filtered = filterRoadPage(progress, span)
              const progressAt = Date.now()
              overviewTileCache.set(tile.key, {
                key: tile.key,
                bounds: tile.bounds,
                page: filtered,
                // A partially scanned tile is immediately drawable, but it
                // must never become a fresh cache hit if navigation aborts
                // the remaining cursor pages.
                storedAt: 0,
                lastUsedAt: progressAt,
              })
              const visible = mergeRoadPages(tiles
                .map((visibleTile) => overviewTileCache.get(visibleTile.key)?.page)
                .filter((visiblePage): visiblePage is MapRoadPage => Boolean(visiblePage)))
              if (visible) applyPage(visible, bounds)
            },
          )
          return { tile, page: filterRoadPage(page, span) }
        })))
        if (requestId !== viewportRequestId.current) return
      }
      if (requestId !== viewportRequestId.current) return

      const storedAt = Date.now()
      results.forEach((result) => {
        if (result.status !== 'fulfilled') return
        overviewTileCache.set(result.value.tile.key, {
          key: result.value.tile.key,
          bounds: result.value.tile.bounds,
          page: result.value.page,
          storedAt,
          lastUsedAt: storedAt,
        })
      })
      pruneOverviewCache(storedAt)
      const visiblePage = mergeRoadPages(tiles
        .map((tile) => overviewTileCache.get(tile.key)?.page)
        .filter((page): page is MapRoadPage => Boolean(page)))
      if (visiblePage) applyPage(visiblePage, bounds)

      const failed = results.some((result) => result.status === 'rejected')
      if (!visiblePage && initial) {
        setError('地図APIから道路データを取得できませんでした。環境が起動中か確認してください。')
      } else {
        setUpdateStopped(failed)
      }
    } finally {
      if (requestId === viewportRequestId.current) {
        setLoading(false)
        setViewportRefreshing(false)
      }
    }
  }, [applyPage])

  const loadViewport = useCallback(async (
    bounds: MapBounds,
    initial: boolean,
    forceRefresh = false,
  ) => {
    latestBounds.current = bounds
    const requestId = ++viewportRequestId.current
    if (initial) {
      setError(undefined)
      setLoading(true)
    }
    if (isDetailBounds(bounds)) {
      await loadDetailViewport(bounds, initial, forceRefresh, requestId)
    } else {
      await loadOverviewViewport(bounds, initial, forceRefresh, requestId)
    }
  }, [loadDetailViewport, loadOverviewViewport])

  const retry = useCallback(() => {
    detailCache.splice(0, detailCache.length)
    overviewTileCache.clear()
    void clearRoadViewportCache()
    setReloadKey((value) => value + 1)
  }, [])

  const refreshMap = useCallback((bounds: MapBounds) => {
    void loadViewport(bounds, false)
  }, [loadViewport])

  useEffect(() => {
    let active = true
    let plowRefreshInFlight = false
    yukisakiApi.getHealth().then(() => {
      if (active) setApiOnline(true)
    }).catch(() => {
      if (active) setApiOnline(false)
    })
    void (async () => {
      const stored = await loadRoadViewport(appConfig.demo.initialBounds)
      let restoredFromDisk = false
      if (active && stored) {
        applyPage(stored.page)
        setLoading(false)
        restoredFromDisk = true
      }
      try {
        const snapshot = await yukisakiApi.getMapSnapshot(appConfig.demo.initialBounds)
        if (!active) return
        setSnowplows(snapshot.snowplows)
        if (!restoredFromDisk) {
          setRoads(snapshot.roads)
          setConditions(snapshot.conditions)
          setMeta(snapshot.meta)
        }
        setLoading(false)
        setError(undefined)
        void loadViewport(appConfig.demo.initialBounds, false)
      } catch {
        if (active) void loadViewport(appConfig.demo.initialBounds, !restoredFromDisk)
      }
    })()
    yukisakiApi.getWeather(appConfig.demo.position).then((value) => {
      if (active) setWeather(value)
    }).catch(() => undefined)
    yukisakiApi.getSnowplows().then((incoming) => {
      if (active) setSnowplows((current) => newerPlows(current, incoming))
    }).catch(() => undefined)

    const roadRefreshTimer = window.setInterval(() => {
      void loadViewport(latestBounds.current, false)
    }, ROAD_REFRESH_INTERVAL_MS)
    const plowRefreshTimer = window.setInterval(() => {
      if (plowRefreshInFlight) return
      plowRefreshInFlight = true
      yukisakiApi.getSnowplows().then((next) => {
        if (!active) return
        setSnowplows((current) => newerPlows(current, next))
        setUpdateStopped(false)
      }).catch(() => {
        if (active) setUpdateStopped(true)
      }).finally(() => {
        plowRefreshInFlight = false
      })
    }, 5_000)

    return () => {
      active = false
      window.clearInterval(roadRefreshTimer)
      window.clearInterval(plowRefreshTimer)
      if (persistTimer.current) window.clearTimeout(persistTimer.current)
      viewportRequestId.current += 1
      viewportAbort.current?.abort()
    }
  }, [applyPage, loadViewport, reloadKey])

  return {
    roads,
    conditions,
    snowplows,
    weather,
    meta,
    loading,
    error,
    updateStopped,
    viewportRefreshing,
    apiOnline,
    retry,
    refreshMap,
  }
}
