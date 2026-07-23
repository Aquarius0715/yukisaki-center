import { PublicApiError, requestJson } from './client'
import type {
  ApiMapSnapshot,
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
import { adaptRoads, adaptSnapshot, adaptSnowplows, isApiMapSnapshot, isApiRoadCollection, isApiSnowplowCollection } from './mapApiAdapter'

const bbox = (bounds?: MapBounds) => bounds
  ? [bounds.minLongitude, bounds.minLatitude, bounds.maxLongitude, bounds.maxLatitude].join(',')
  : undefined

export class HttpYukisakiApi implements YukisakiApi {
  private latestSnapshot?: MapSnapshot

  constructor(private readonly baseUrl: string) {}

  private url(path: string, query?: Record<string, string | undefined>) {
    const url = new URL(`${this.baseUrl}${path}`)
    Object.entries(query ?? {}).forEach(([key, value]) => { if (value !== undefined) url.searchParams.set(key, value) })
    return url.toString()
  }

  async getMapSnapshot(bounds?: MapBounds) {
    const value = await requestJson<unknown>(this.url('/v1/map/snapshot', { bbox: bbox(bounds), limit: '5000' }))
    if (!isApiMapSnapshot(value)) throw new PublicApiError('地図APIの応答形式が正しくありません。')
    this.latestSnapshot = adaptSnapshot(value as ApiMapSnapshot)
    return this.latestSnapshot
  }

  async getRoadSegments(bounds?: MapBounds) {
    const value = await requestJson<unknown>(this.url('/v1/road-segments', { bbox: bbox(bounds), limit: '5000' }))
    if (!isApiRoadCollection(value)) throw new PublicApiError('道路APIの応答形式が正しくありません。')
    const adapted = adaptRoads(value as ApiRoadCollection)
    return { ...adapted, truncated: (value as ApiRoadCollection).truncated }
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

  async getSnowplows() {
    const value = await requestJson<unknown>(this.url('/v1/snowplows'))
    if (!isApiSnowplowCollection(value)) throw new PublicApiError('除雪車APIの応答形式が正しくありません。')
    return adaptSnowplows(value as ApiSnowplowCollection)
  }

  getWeather(_position: Position) { return Promise.reject(new PublicApiError('天気APIは現在のMap API対象外です。', 404)) }
  getDestinations(_query: string): Promise<Destination[]> { return Promise.reject(new PublicApiError('目的地APIは現在のMap API対象外です。', 404)) }
  recommendRoutes(_request: RouteRecommendationRequest) { return Promise.reject(new PublicApiError('経路APIは現在のMap API対象外です。', 404)) }
}
