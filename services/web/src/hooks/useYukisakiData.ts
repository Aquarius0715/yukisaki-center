import { useCallback, useEffect, useRef, useState } from 'react'
import { yukisakiApi } from '../api/createYukisakiApi'
import { appConfig } from '../api/config'
import type { MapBounds, MapDataMeta, RoadCondition, RoadSegmentFeatureCollection, Snowplow, WeatherData } from '../api/contracts'

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

  const loadViewport = useCallback(async (bounds: MapBounds, initial: boolean) => {
    const requestId = ++viewportRequestId.current
    viewportAbort.current?.abort()
    const controller = new AbortController()
    viewportAbort.current = controller
    if (initial) {
      setLoading(true)
      setError(undefined)
    } else {
      setViewportRefreshing(true)
    }
    setUpdateStopped(false)

    const snowplowsRequest = yukisakiApi.getSnowplows(undefined, controller.signal).then((incoming) => {
      if (requestId === viewportRequestId.current) {
        setSnowplows((current) => newerPlows(current, incoming))
      }
    }).catch(() => undefined)

    try {
      // Render only the first page for the current viewport. Automatically
      // accumulating cursor pages caused thousands of MapKit overlays to be
      // recreated and could terminate the browser tab on mobile devices.
      const page = await yukisakiApi.getMapRoadPage(bounds, undefined, controller.signal)
      if (requestId !== viewportRequestId.current) return
      setRoads(page.roads)
      setConditions(page.conditions)
      setMeta({ ...page.meta, truncated: page.nextCursor !== null })
      if (initial) setLoading(false)
      await snowplowsRequest
      if (requestId === viewportRequestId.current) setUpdateStopped(false)
    } catch {
      if (requestId !== viewportRequestId.current) return
      if (initial) {
        setError('地図APIから道路データを取得できませんでした。環境が起動中か確認してください。')
      } else {
        setUpdateStopped(true)
      }
    } finally {
      if (requestId === viewportRequestId.current) {
        if (initial) setLoading(false)
        setViewportRefreshing(false)
      }
    }
  }, [])

  const retry = useCallback(() => setReloadKey((value) => value + 1), [])
  const refreshMap = useCallback((bounds: MapBounds) => {
    void loadViewport(bounds, false)
  }, [loadViewport])

  useEffect(() => {
    let active = true
    let refreshInFlight = false
    void loadViewport(appConfig.demo.initialBounds, true)
    yukisakiApi.getWeather(appConfig.demo.position).then((value) => {
      if (active) setWeather(value)
    }).catch(() => undefined)

    const pollTimer = window.setInterval(() => {
      if (refreshInFlight) return
      refreshInFlight = true
      yukisakiApi.getSnowplows().then((next) => {
        if (!active) return
        setSnowplows((current) => newerPlows(current, next))
        setUpdateStopped(false)
      }).catch(() => {
        if (active) setUpdateStopped(true)
      }).finally(() => {
        refreshInFlight = false
      })
    }, 5_000)

    return () => {
      active = false
      window.clearInterval(pollTimer)
      viewportRequestId.current += 1
      viewportAbort.current?.abort()
    }
  }, [loadViewport, reloadKey])

  return { roads, conditions, snowplows, weather, meta, loading, error, updateStopped, viewportRefreshing, retry, refreshMap }
}
