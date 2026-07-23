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
  const [reloadKey, setReloadKey] = useState(0)
  const [viewportLoading, setViewportLoading] = useState(false)
  const [viewportError, setViewportError] = useState<string>()
  const requestSequence = useRef(0)
  const retry = useCallback(() => setReloadKey((value) => value + 1), [])
  const loadViewport = useCallback((bounds: MapBounds) => {
    const sequence = ++requestSequence.current
    setViewportLoading(true)
    setViewportError(undefined)
    yukisakiApi.getRoadSegments(bounds).then((result) => {
      if (sequence !== requestSequence.current) return
      setRoads(result.roads)
      setConditions(result.conditions)
      setMeta((current) => current ? { ...current, truncated: result.truncated } : current)
    }).catch(() => {
      if (sequence === requestSequence.current) setViewportError('この範囲の道路データを取得できませんでした')
    }).finally(() => {
      if (sequence === requestSequence.current) setViewportLoading(false)
    })
  }, [])

  useEffect(() => {
    let active = true
    let pollTimer: number | undefined
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
          yukisakiApi.getSnowplows(appConfig.demo.bounds).then((next) => {
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

  return { roads, conditions, snowplows, weather, meta, loading, error, updateStopped, viewportLoading, viewportError, loadViewport, retry }
}
