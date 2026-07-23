import { PublicApiError, requestJson } from './client'
import type {
  ApiRoadCollection,
  ApiSnowplowCollection,
  Destination,
  MapBounds,
  MapSnapshot,
  Position,
  RoadCondition,
  RouteRecommendationRequest,
  SnowmeltPipeStatus,
  YukisakiApi,
} from './contracts'
import { adaptRoadPage, adaptSnowplows, isApiRoadCollection, isApiSnowplowCollection } from './mapApiAdapter'

// Use a larger overview sample so roads do not appear as isolated fragments,
// while keeping MapKit far below the previous 5,000-feature crash case.
const OVERVIEW_PAGE_LIMIT = '800'
const DETAIL_PAGE_LIMIT = '1200'
const DETAIL_SPAN_THRESHOLD = 0.035
const MAP_PAGE_TIMEOUT_MS = 10_000

const bbox = (bounds?: MapBounds) => bounds
  ? [bounds.minLongitude, bounds.minLatitude, bounds.maxLongitude, bounds.maxLatitude].join(',')
  : undefined

const pageLimit = (bounds?: MapBounds) => {
  if (!bounds) return OVERVIEW_PAGE_LIMIT
  const span = Math.max(
    bounds.maxLongitude - bounds.minLongitude,
    bounds.maxLatitude - bounds.minLatitude,
  )
  return span <= DETAIL_SPAN_THRESHOLD ? DETAIL_PAGE_LIMIT : OVERVIEW_PAGE_LIMIT
}

export class HttpYukisakiApi implements YukisakiApi {
  private latestSnapshot?: MapSnapshot

  constructor(private readonly baseUrl: string) {}

  private url(path: string, query?: Record<string, string | undefined>) {
    const baseUrl = this.baseUrl || window.location.origin
    const url = new URL(path, `${baseUrl.replace(/\/$/, '')}/`)
    Object.entries(query ?? {}).forEach(([key, value]) => { if (value !== undefined) url.searchParams.set(key, value) })
    return url.toString()
  }

  async getMapSnapshot(bounds?: MapBounds, signal?: AbortSignal) {
    const [page, snowplows] = await Promise.all([
      this.getMapRoadPage(bounds, undefined, signal),
      this.getSnowplows(undefined, signal),
    ])
    this.latestSnapshot = { roads: page.roads, conditions: page.conditions, snowplows, meta: page.meta }
    return this.latestSnapshot
  }

  async getMapRoadPage(bounds?: MapBounds, cursor?: string, signal?: AbortSignal, limit?: number) {
    const value = await requestJson<unknown>(
      this.url('/v1/road-segments', { bbox: bbox(bounds), limit: limit ? String(limit) : pageLimit(bounds), cursor }),
      { signal },
      MAP_PAGE_TIMEOUT_MS,
    )
    if (!isApiRoadCollection(value)) throw new PublicApiError('道路APIの応答形式が正しくありません。')
    return adaptRoadPage(value as ApiRoadCollection)
  }

  async getRoadSegments(bounds?: MapBounds, signal?: AbortSignal) {
    return (await this.getMapRoadPage(bounds, undefined, signal)).roads
  }

  async getRoadConditions(segmentIds?: string[]): Promise<RoadCondition[]> {
    const snapshot = this.latestSnapshot ?? await this.getMapSnapshot()
    return snapshot.conditions.filter((condition) => !segmentIds || segmentIds.includes(condition.segmentId))
  }

  async getSnowmeltPipes(): Promise<SnowmeltPipeStatus[]> {
    const snapshot = this.latestSnapshot ?? await this.getMapSnapshot()
    return snapshot.conditions.map((condition) => ({
      segmentId: condition.segmentId,
      installed: condition.hasSnowmeltPipe,
      operating: condition.snowmeltPipeOperating,
      lastUpdatedAt: condition.updatedAt,
    }))
  }

  async getSnowplows(_bounds?: MapBounds, signal?: AbortSignal) {
    const value = await requestJson<unknown>(this.url('/v1/snowplows'), { signal })
    if (!isApiSnowplowCollection(value)) throw new PublicApiError('除雪車APIの応答形式が正しくありません。')
    return adaptSnowplows(value as ApiSnowplowCollection)
  }

  getWeather(_position: Position) { return Promise.reject(new PublicApiError('天気APIは現在のMap API対象外です。', 404)) }
  getDestinations(_query: string): Promise<Destination[]> { return Promise.reject(new PublicApiError('目的地APIは現在のMap API対象外です。', 404)) }
  recommendRoutes(_request: RouteRecommendationRequest) { return Promise.reject(new PublicApiError('経路APIは現在のMap API対象外です。', 404)) }
}
