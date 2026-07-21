import { useCallback, useEffect, useState } from 'react'
import { yukisakiApi } from '../api/createYukisakiApi'
import { appConfig } from '../api/config'
import type { RoadCondition, RoadSegmentFeatureCollection, Snowplow, WeatherData } from '../api/contracts'

export function useYukisakiData() {
  const [roads, setRoads] = useState<RoadSegmentFeatureCollection>()
  const [conditions, setConditions] = useState<RoadCondition[]>([])
  const [snowplows, setSnowplows] = useState<Snowplow[]>([])
  const [weather, setWeather] = useState<WeatherData>()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string>()
  const [reloadKey, setReloadKey] = useState(0)
  const retry = useCallback(() => setReloadKey((value) => value + 1), [])

  useEffect(() => {
    let active = true
    setLoading(true); setError(undefined)
    yukisakiApi.getRoadSegments().then(async (roadData) => {
      const [conditionData, plowData, weatherData] = await Promise.all([
        yukisakiApi.getRoadConditions(roadData.features.map((feature) => feature.properties.segment_id)),
        yukisakiApi.getSnowplows(), yukisakiApi.getWeather(appConfig.demo.position),
      ])
      if (active) { setRoads(roadData); setConditions(conditionData); setSnowplows(plowData); setWeather(weatherData) }
    }).catch(() => { if (active) setError('道路データを読み込めませんでした。') }).finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [reloadKey])

  return { roads, conditions, snowplows, weather, loading, error, retry }
}
