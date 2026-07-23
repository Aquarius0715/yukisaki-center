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

// MapKit creates one or more native overlay objects for every road feature.
// Keep a viewport page deliberately small; additional roads are fetched after
// the user moves the map instead of accumulating every cursor page in memory.
const MAP_PAGE_LIMIT = '75'
const MAP_PAGE_TIMEOUT_MS = 10_000

const bbox = (bounds?: MapBounds) => bounds
  ? [bounds.minLongitude, bounds.minLatitude, bounds.maxLongitude, bounds.maxLatitude].join(',')
  : undefined

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

  async getMapRoadPage(bounds?: MapBounds, cursor?: string, signal?: AbortSignal) {
    const value = await requestJson<unknown>(
      this.url('/v1/road-segments', { bbox: bbox(bounds), limit: MAP_PAGE_LIMIT, cursor }),
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
