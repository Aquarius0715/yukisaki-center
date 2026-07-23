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
  const retry = useCallback(() => setReloadKey((value) => value + 1), [])
  const refreshMap = useCallback((bounds: MapBounds) => {
    const requestId = ++viewportRequestId.current
    setViewportRefreshing(true)
    yukisakiApi.getMapSnapshot(bounds).then((snapshot) => {
      if (requestId !== viewportRequestId.current) return
      setRoads(snapshot.roads)
      setConditions(snapshot.conditions)
      setSnowplows((current) => newerPlows(current, snapshot.snowplows))
      setMeta(snapshot.meta)
      setUpdateStopped(false)
    }).catch(() => {
      if (requestId === viewportRequestId.current) setUpdateStopped(true)
    }).finally(() => {
      if (requestId === viewportRequestId.current) setViewportRefreshing(false)
    })
  }, [])

  useEffect(() => {
    let active = true
    let pollTimer: number | undefined
    viewportRequestId.current += 1
    setLoading(true)
    setError(undefined)
    setUpdateStopped(false)

    yukisakiApi.getMapSnapshot(appConfig.demo.bounds).then((snapshot) => {
      if (!active) return
      setRoads(snapshot.roads)
      setConditions(snapshot.conditions)
      setSnowplows(snapshot.snowplows)
      setMeta(snapshot.meta)

      if (snapshot.meta.source === 'api') {
        let refreshInFlight = false
        pollTimer = window.setInterval(() => {
          if (refreshInFlight) return
          refreshInFlight = true
          yukisakiApi.getSnowplows().then((next) => {
            if (!active) return
            setSnowplows((current) => newerPlows(current, next))
            setUpdateStopped(false)
          }).catch(() => { if (active) setUpdateStopped(true) }).finally(() => { refreshInFlight = false })
        }, 5_000)
      }
    }).catch(() => {
      if (active) setError('地図APIから道路データを取得できませんでした。環境が起動中か確認してください。')
    }).finally(() => { if (active) setLoading(false) })

    yukisakiApi.getWeather(appConfig.demo.position).then((value) => { if (active) setWeather(value) }).catch(() => undefined)

    return () => {
      active = false
      if (pollTimer) window.clearInterval(pollTimer)
    }
  }, [reloadKey])

  return { roads, conditions, snowplows, weather, meta, loading, error, updateStopped, viewportRefreshing, retry, refreshMap }
}
