import { requestJson } from './client'
import { isRoadFeatureCollection, type MapBounds, type Position, type RoadCondition, type RouteRecommendationRequest, type RouteRecommendationResponse, type SnowmeltPipeStatus, type Snowplow, type WeatherData, type Destination, type YukisakiApi } from './contracts'

const bbox = (bounds?: MapBounds) => bounds ? [bounds.minLongitude, bounds.minLatitude, bounds.maxLongitude, bounds.maxLatitude].join(',') : undefined

export class HttpYukisakiApi implements YukisakiApi {
  constructor(private readonly baseUrl: string) {}
  private url(path: string, query?: Record<string, string | undefined>) {
    const url = new URL(`${this.baseUrl}${path}`)
    Object.entries(query ?? {}).forEach(([key, value]) => { if (value !== undefined) url.searchParams.set(key, value) })
    return url.toString()
  }
  async getRoadSegments(bounds?: MapBounds) {
    const data = await requestJson<unknown>(this.url('/road-segments', { bbox: bbox(bounds) }))
    if (!isRoadFeatureCollection(data)) throw new Error('道路データの形式が正しくありません。')
    return data
  }
  getRoadConditions(segmentIds?: string[]) { return requestJson<RoadCondition[]>(this.url('/road-conditions/query'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ segmentIds }) }) }
  getSnowmeltPipes(bounds?: MapBounds) { return requestJson<SnowmeltPipeStatus[]>(this.url('/snowmelt-pipes', { bbox: bbox(bounds) })) }
  getSnowplows(bounds?: MapBounds) { return requestJson<Snowplow[]>(this.url('/snowplows', { bbox: bbox(bounds) })) }
  getWeather(position: Position) { return requestJson<WeatherData>(this.url('/weather', { lat: String(position.latitude), lon: String(position.longitude) })) }
  getDestinations(query: string) { return requestJson<Destination[]>(this.url('/destinations', { q: query })) }
  recommendRoutes(request: RouteRecommendationRequest) { return requestJson<RouteRecommendationResponse>(this.url('/routes/recommend'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(request) }) }
}
