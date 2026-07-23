import { useCallback, useEffect, useRef, useState } from 'react'
import { yukisakiApi } from '../api/createYukisakiApi'
import { appConfig } from '../api/config'
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

const DETAIL_MAX_SPAN_DEGREES = 0.035
const DETAIL_PAGE_LIMIT = 1_200
const DETAIL_CACHE_MAX_ENTRIES = 4
const OVERVIEW_CACHE_MAX_ENTRIES = 32
const OVERVIEW_MAX_VISIBLE_TILES = 6
const OVERVIEW_REQUEST_CONCURRENCY = 3
const OVERVIEW_TOTAL_PAGE_LIMIT = 1_200
const OVERVIEW_MIN_TILE_LIMIT = 160
const ROAD_CACHE_FRESH_MS = 60_000
const ROAD_CACHE_MAX_AGE_MS = 10 * 60_000
const ROAD_REFRESH_INTERVAL_MS = 60_000
const DETAIL_BOUNDS_PADDING = 0.18
const WEB_MERCATOR_MAX_LATITUDE = 85.05112878

const detailCache: CachedRoadPage[] = []
const overviewTileCache = new Map<string, CachedRoadPage>()

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

function mergeRoadPages(pages: MapRoadPage[]): MapRoadPage | undefined {
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
    truncated: pages.some((page) => page.meta.truncated || page.nextCursor !== null),
    source: pages.some((page) => page.meta.source === 'mock') ? 'mock' : 'api',
  }
  return {
    roads: { type: 'FeatureCollection', features: [...features.values()] },
    conditions: [...conditions.values()],
    meta,
    nextCursor: null,
  }
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
  const [reloadKey, setReloadKey] = useState(0)
  const viewportRequestId = useRef(0)
  const viewportAbort = useRef<AbortController | undefined>(undefined)
  const latestBounds = useRef<MapBounds>(appConfig.demo.initialBounds)

  const applyPage = useCallback((page: MapRoadPage) => {
    setRoads(page.roads)
    setConditions(page.conditions)
    setMeta({ ...page.meta, truncated: page.meta.truncated || page.nextCursor !== null })
  }, [])

  const loadDetailViewport = useCallback(async (
    bounds: MapBounds,
    initial: boolean,
    forceRefresh: boolean,
    requestId: number,
  ) => {
    const now = Date.now()
    const cached = findDetailCache(bounds, now)
    if (cached) applyPage(cached.page)
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
      const page = await yukisakiApi.getMapRoadPage(
        requestBounds,
        undefined,
        controller.signal,
        DETAIL_PAGE_LIMIT,
      )
      if (requestId !== viewportRequestId.current) return
      cacheDetailPage(requestBounds, page, Date.now())
      applyPage(page)
      setUpdateStopped(false)
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
    if (cachedPage) applyPage(cachedPage)

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

    const tileLimit = Math.max(
      OVERVIEW_MIN_TILE_LIMIT,
      Math.floor(OVERVIEW_TOTAL_PAGE_LIMIT / tiles.length),
    )
    try {
      const results: Array<PromiseSettledResult<{ tile: RoadTile; page: MapRoadPage }>> = []
      for (let index = 0; index < tilesToFetch.length; index += OVERVIEW_REQUEST_CONCURRENCY) {
        const batch = tilesToFetch.slice(index, index + OVERVIEW_REQUEST_CONCURRENCY)
        results.push(...await Promise.allSettled(batch.map(async (tile) => {
          const page = await yukisakiApi.getMapRoadPage(
            tile.bounds,
            undefined,
            controller.signal,
            tileLimit,
          )
          return { tile, page }
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
      if (visiblePage) applyPage(visiblePage)

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
    setReloadKey((value) => value + 1)
  }, [])

  const refreshMap = useCallback((bounds: MapBounds) => {
    void loadViewport(bounds, false)
  }, [loadViewport])

  useEffect(() => {
    let active = true
    let plowRefreshInFlight = false
    void loadViewport(appConfig.demo.initialBounds, true)
    yukisakiApi.getWeather(appConfig.demo.position).then((value) => {
      if (active) setWeather(value)
    }).catch(() => undefined)
    yukisakiApi.getSnowplows().then((incoming) => {
      if (active) setSnowplows((current) => newerPlows(current, incoming))
    }).catch(() => undefined)

    const roadRefreshTimer = window.setInterval(() => {
      void loadViewport(latestBounds.current, false, true)
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
      viewportRequestId.current += 1
      viewportAbort.current?.abort()
    }
  }, [loadViewport, reloadKey])

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
    retry,
    refreshMap,
  }
}
