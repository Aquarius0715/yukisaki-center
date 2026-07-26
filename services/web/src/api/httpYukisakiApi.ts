import { PublicApiError, requestJson } from './client'
import type {
  ApiHealth,
  ApiRouteResponse,
  ApiRoadCollection,
  ApiSnowplowCollection,
  AssistantMetadata,
  DangerExplanation,
  Destination,
  DestinationSuggestion,
  MapBounds,
  MapSnapshot,
  ParsedRouteRequest,
  Position,
  RoadCondition,
  RouteExplanation,
  RouteRecommendationRequest,
  RouteRecommendationResponse,
  SnowmeltPipeStatus,
  YukisakiApi,
} from './contracts'
import {
  adaptCondition,
  adaptRoadFeature,
  adaptRoadPage,
  adaptSnapshot,
  adaptSnowplows,
  isApiMapSnapshot,
  isApiRoadCollection,
  isApiSnowplowCollection,
} from './mapApiAdapter'

// Viewport loading supplies an explicit limit. These defaults keep the initial
// snapshot useful while the zoom-aware, tiled road request completes.
const OVERVIEW_PAGE_LIMIT = '2000'
const DETAIL_PAGE_LIMIT = '3000'
const DETAIL_SPAN_THRESHOLD = 0.04
const MAP_PAGE_TIMEOUT_MS = 15_000
const ROUTE_TIMEOUT_MS = 30_000
const AI_TIMEOUT_MS = 45_000
const REFERENCE_TIME = '2026-01-23T12:00:00+09:00'

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

  private post(path: string, body: unknown, timeout = ROUTE_TIMEOUT_MS) {
    return requestJson<unknown>(this.url(path), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }, timeout)
  }

  async getHealth(signal?: AbortSignal): Promise<ApiHealth> {
    const value = await requestJson<unknown>(this.url('/healthz'), { signal })
    if (!isRecord(value) || typeof value.status !== 'string') {
      throw new PublicApiError('稼働確認APIの応答形式が正しくありません。')
    }
    return { status: value.status }
  }

  async getMapSnapshot(bounds?: MapBounds, signal?: AbortSignal) {
    const value = await requestJson<unknown>(
      this.url('/v1/map/snapshot', { bbox: bbox(bounds), limit: pageLimit(bounds), view: 'map' }),
      { signal },
      MAP_PAGE_TIMEOUT_MS,
    )
    if (!isApiMapSnapshot(value)) throw new PublicApiError('地図スナップショットAPIの応答形式が正しくありません。')
    this.latestSnapshot = adaptSnapshot(value)
    return this.latestSnapshot
  }

  async getMapRoadPage(bounds?: MapBounds, cursor?: string, signal?: AbortSignal, limit?: number) {
    const value = await requestJson<unknown>(
      this.url('/v1/road-segments', { bbox: bbox(bounds), limit: limit ? String(limit) : pageLimit(bounds), cursor, view: 'map' }),
      { signal },
      MAP_PAGE_TIMEOUT_MS,
    )
    if (!isApiRoadCollection(value)) throw new PublicApiError('道路APIの応答形式が正しくありません。')
    return adaptRoadPage(value as ApiRoadCollection)
  }

  async getRoadSegments(bounds?: MapBounds, signal?: AbortSignal) {
    return (await this.getMapRoadPage(bounds, undefined, signal)).roads
  }

  async getRoadSegment(segmentId: string, signal?: AbortSignal) {
    const value = await requestJson<unknown>(
      this.url(`/v1/road-segments/${encodeURIComponent(segmentId)}`),
      { signal },
    )
    if (!isRoadFeature(value)) throw new PublicApiError('道路詳細APIの応答形式が正しくありません。')
    return { road: adaptRoadFeature(value), condition: adaptCondition(value.properties) }
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

  async autocompleteDestinations(query: string, signal?: AbortSignal): Promise<DestinationSuggestion[]> {
    const normalized = query.trim()
    if (normalized.length < 2) return []
    const value = await requestJson<unknown>(
      this.url('/v1/places/autocomplete', { q: normalized }),
      { signal },
    )
    if (!isPlaceEnvelope(value)) throw new PublicApiError('地点入力補完APIの応答形式が正しくありません。')
    return value.results.flatMap((item, index) => {
      if (!isRecord(item) || typeof item.name !== 'string' || typeof item.query !== 'string') return []
      return [{
        id: `suggestion-${index}-${item.query}`,
        name: item.name,
        address: typeof item.subtitle === 'string' ? item.subtitle : '',
        query: item.query,
      }]
    })
  }

  async getDestinations(query: string): Promise<Destination[]> {
    const normalized = query.trim()
    if (normalized.length < 2) return []
    const value = await requestJson<unknown>(this.url('/v1/places/search', { q: normalized }))
    if (!isPlaceEnvelope(value)) throw new PublicApiError('地点検索APIの応答形式が正しくありません。')
    return value.results.flatMap((item) => {
      if (
        !isRecord(item)
        || typeof item.place_id !== 'string'
        || typeof item.name !== 'string'
        || typeof item.latitude !== 'number'
        || typeof item.longitude !== 'number'
      ) return []
      return [{
        id: item.place_id,
        name: item.name,
        address: typeof item.address === 'string' ? item.address : '',
        latitude: item.latitude,
        longitude: item.longitude,
      }]
    })
  }

  async recommendRoutes(request: RouteRecommendationRequest): Promise<RouteRecommendationResponse> {
    const mode = {
      fastest: 'time_priority',
      recommended: 'balanced',
      'snow-priority': 'drivability_priority',
    }[request.preference]
    const value = await this.post('/v1/routes', {
      origin: request.origin,
      destination: request.destination,
      mode,
      options: {
        avoid: request.avoid ?? [],
        prefer: request.prefer ?? [],
        max_detour_minutes: request.maxDetourMinutes ?? 10,
      },
      reference_time: REFERENCE_TIME,
    })
    if (!isRouteResponse(value)) throw new PublicApiError('経路APIの応答形式が正しくありません。')
    return {
      routes: value.routes.map((route) => {
        const factors = [...new Set(route.hazard_groups.flatMap((hazard) => hazard.factors))]
        return {
          id: route.route_id,
          label: routeLabel(route.label),
          durationMinutes: Math.max(1, Math.round(route.duration_s / 60)),
          distanceKm: Math.round(route.distance_m / 100) / 10,
          drivabilityScore: Math.round(route.average_drivability_score ?? route.minimum_drivability_score ?? 0),
          plowedRatio: route.plowed_ratio,
          snowmeltPipeRatio: route.snow_pipe_ratio,
          noPlowRecordSegmentCount: null,
          hasNarrowRoad: factors.includes('narrow_road'),
          hasSteepSlope: factors.includes('steep_slope'),
          geometry: route.geometry,
          warnings: factors.map(factorLabel),
          reasons: [
            `最低指数 ${route.minimum_drivability_score ?? '未算出'}`,
            `指数カバー率 ${Math.round(route.score_coverage * 100)}%`,
          ],
        }
      }),
      generatedAt: value.data_timestamp,
      isSimulated: value.is_simulated,
      apiResponse: value,
    }
  }

  async parseRouteRequest(text: string): Promise<ParsedRouteRequest> {
    const value = await this.post('/v1/ai/parse-route-request', { text }, AI_TIMEOUT_MS)
    if (!isAssistantEnvelope(value) || !isParsedRouteResult(value.result)) {
      throw new PublicApiError('AI条件抽出APIの応答形式が正しくありません。')
    }
    return {
      originQuery: value.result.origin_query,
      destinationQuery: value.result.destination_query,
      viaQueries: value.result.via_queries,
      priority: value.result.priority,
      avoidConditions: value.result.avoid_conditions,
      preferConditions: value.result.prefer_conditions,
      driverExperience: value.result.driver_experience,
      missingFields: value.result.missing_fields,
      needsConfirmation: value.result.needs_confirmation,
      metadata: assistantMetadata(value.metadata),
    }
  }

  async explainRoutes(routes: ApiRouteResponse): Promise<RouteExplanation> {
    const value = await this.post('/v1/ai/explain-routes', routes, AI_TIMEOUT_MS)
    if (!isAssistantEnvelope(value) || !isRouteExplanationResult(value.result)) {
      throw new PublicApiError('AI経路説明APIの応答形式が正しくありません。')
    }
    return {
      recommendedRouteId: value.result.recommended_route_id,
      recommendationReason: value.result.recommendation_reason,
      routes: value.result.routes.map((route: {
        route_id: string
        summary: string
        advantages: string[]
        cautions: string[]
      }) => ({
        routeId: route.route_id,
        summary: route.summary,
        advantages: route.advantages,
        cautions: route.cautions,
      })),
      metadata: assistantMetadata(value.metadata),
    }
  }

  async explainDangerPoints(routes: ApiRouteResponse, routeId: string): Promise<DangerExplanation> {
    const route = routes.routes.find((item) => item.route_id === routeId)
    if (!route) throw new PublicApiError('説明対象の経路が見つかりません。')
    if (!route.hazard_groups.length) {
      return {
        hazards: [],
        metadata: {
          model_id: 'not-invoked',
          fallback_used: false,
          is_simulated: routes.is_simulated,
          data_timestamp: routes.data_timestamp,
        },
      }
    }
    const value = await this.post('/v1/ai/explain-danger-points', {
      data_timestamp: routes.data_timestamp,
      is_simulated: routes.is_simulated,
      hazards: route.hazard_groups.map((hazard, index) => ({
        hazard_id: `${route.route_id}-hazard-${index + 1}`,
        rules: hazard.factors,
        minimum_drivability_score: hazard.minimum_drivability_score,
      })),
    }, AI_TIMEOUT_MS)
    if (!isAssistantEnvelope(value) || !isDangerExplanationResult(value.result)) {
      throw new PublicApiError('AI危険説明APIの応答形式が正しくありません。')
    }
    return {
      hazards: value.result.hazards.map((hazard: {
        hazard_id: string
        explanation: string
        cautions: string[]
      }) => ({
        hazardId: hazard.hazard_id,
        explanation: hazard.explanation,
        cautions: hazard.cautions,
      })),
      metadata: assistantMetadata(value.metadata),
    }
  }
}

function isRecord(value: unknown): value is Record<string, any> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function isRoadFeature(value: unknown): value is ApiRoadCollection['features'][number] {
  return isRecord(value)
    && value.type === 'Feature'
    && isRecord(value.properties)
    && typeof value.properties.segment_id === 'string'
    && isRecord(value.geometry)
    && (value.geometry.type === 'LineString' || value.geometry.type === 'MultiLineString')
}

function isPlaceEnvelope(value: unknown): value is { results: unknown[] } {
  return isRecord(value) && Array.isArray(value.results)
}

function isRouteResponse(value: unknown): value is ApiRouteResponse {
  return isRecord(value)
    && typeof value.request_id === 'string'
    && typeof value.data_timestamp === 'string'
    && typeof value.is_simulated === 'boolean'
    && Array.isArray(value.routes)
    && value.routes.every((route: unknown) => isRecord(route)
      && typeof route.route_id === 'string'
      && isRecord(route.geometry)
      && route.geometry.type === 'LineString'
      && Array.isArray(route.hazard_groups))
}

function isAssistantEnvelope(value: unknown): value is { result: Record<string, any>; metadata: Record<string, any> } {
  return isRecord(value) && isRecord(value.result) && isRecord(value.metadata)
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string')
}

function isParsedRouteResult(value: Record<string, any>) {
  return (typeof value.origin_query === 'string' || value.origin_query === null)
    && (typeof value.destination_query === 'string' || value.destination_query === null)
    && isStringArray(value.via_queries)
    && ['time', 'balanced', 'safety'].includes(value.priority)
    && isStringArray(value.avoid_conditions)
    && isStringArray(value.prefer_conditions)
    && isStringArray(value.missing_fields)
}

function isRouteExplanationResult(value: Record<string, any>) {
  return typeof value.recommended_route_id === 'string'
    && typeof value.recommendation_reason === 'string'
    && Array.isArray(value.routes)
}

function isDangerExplanationResult(value: Record<string, any>) {
  return Array.isArray(value.hazards)
}

function assistantMetadata(value: Record<string, any>): AssistantMetadata {
  return {
    model_id: typeof value.model_id === 'string' ? value.model_id : 'unknown',
    fallback_used: value.fallback_used === true,
    is_simulated: value.is_simulated === true,
    data_timestamp: typeof value.data_timestamp === 'string' ? value.data_timestamp : null,
  }
}

function routeLabel(label: string) {
  return {
    fastest: '時間優先',
    balanced: 'バランス',
    most_drivable: '走りやすさ優先',
    alternative: '代替経路',
  }[label] ?? label
}

function factorLabel(factor: string) {
  return {
    steep_slope: '急勾配区間があります',
    bridge: '橋梁区間があります',
    no_plow_history: '除雪実績を確認できない区間があります',
    freezing_wet_condition: '凍結しやすい条件の区間があります',
  }[factor] ?? factor.split('_').join(' ')
}
