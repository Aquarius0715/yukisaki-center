import type { Feature, FeatureCollection, LineString, MultiLineString, Point } from 'geojson'

export type Position = { latitude: number; longitude: number }
export type MapBounds = { minLongitude: number; minLatitude: number; maxLongitude: number; maxLatitude: number }

export type ScoreBreakdown = {
  base: number
  snowmeltPipe: number
  snowmeltPipeOperation: number
  recentPlowing: number
  roadClass: number
  roadWidth: number
  slope: number
  dataFreshness: number
  finalScore: number
}

export type RoadSegmentProperties = {
  segment_id: string
  source_edge_id: string | null
  osm_id: string | null
  osmid: string | null
  road_name: string | null
  name: string | null
  highway: string | null
  oneway: boolean | string | null
  maxspeed: string | number | null
  lanes: string | number | null
  lanes_forward: string | number | null
  lanes_backward: string | number | null
  surface: string | null
  width: string | number | null
  bridge: string | null
  tunnel: string | null
  segment_index: number
  segment_count: number
  length_m: number
  start_lon: number
  start_lat: number
  end_lon: number
  end_lat: number
  confidence?: number
  data_timestamp?: string | null
  is_simulated?: boolean
}

export type RoadGeometry = LineString | MultiLineString
export type RoadSegmentFeature = Feature<RoadGeometry, RoadSegmentProperties>
export type RoadSegmentFeatureCollection = FeatureCollection<RoadGeometry, RoadSegmentProperties>
export type RoadConditionStatus = 'snowmelt' | 'recently_plowed' | 'plowed' | 'stale_plow_data' | 'no_plow_record' | 'warning'

export type RoadCondition = {
  segmentId: string
  hasSnowmeltPipe: boolean
  snowmeltPipeOperating: boolean
  lastPlowedAt: string | null
  plowVehicleId: string | null
  roadWidthM: number | null
  slopePercent: number | null
  drivabilityScore: number
  hasDrivabilityScore?: boolean
  status: RoadConditionStatus
  scoreBreakdown: ScoreBreakdown
  scoreFactors?: Record<string, number | boolean | string | null>
  scoreFactorDetails?: Array<{ label: string; value: number | boolean | string | null }>
  reasons: string[]
  warnings: string[]
  updatedAt: string
  isSimulated: boolean
}

export type SnowmeltPipeStatus = { segmentId: string; installed: boolean; operating: boolean; lastUpdatedAt: string }
export type Snowplow = {
  id: string
  name: string
  status: 'working' | 'moving' | 'stopped'
  latitude: number
  longitude: number
  heading: number
  speedKmh: number
  lastUpdatedAt: string
  todayDistanceKm: number | null
  track?: LineString
  plannedRoute?: LineString
  matchedSegmentId?: string | null
  confidence?: number
  isSimulated: boolean
}
export type WeatherData = { temperatureC: number; condition: string; observedAt: string; isSimulated: boolean }
export type Destination = Position & { id: string; name: string; address: string }
export type DestinationSuggestion = {
  id: string
  name: string
  address: string
  query: string
}
export type RoutePreference = 'fastest' | 'recommended' | 'snow-priority'
export type RouteRecommendationRequest = {
  origin: Position
  destination: Position
  preference: RoutePreference
  avoid?: Array<'steep_road' | 'bridge'>
  prefer?: Array<'main_road' | 'recently_plowed'>
  maxDetourMinutes?: number
}
export type RecommendedRoute = {
  id: string
  label: string
  durationMinutes: number
  distanceKm: number
  drivabilityScore: number
  plowedRatio: number
  snowmeltPipeRatio: number
  noPlowRecordSegmentCount: number | null
  hasNarrowRoad: boolean
  hasSteepSlope: boolean
  geometry: LineString
  warnings: string[]
  reasons: string[]
}

export type ApiHazardEvidence = {
  road_name?: string
  length_m?: number
  max_slope_percent?: number
  snowfall_1h_cm?: number
  temperature_c?: number
  last_plowed_at?: string
}

export type ApiHazardGroup = {
  segment_ids: string[]
  minimum_drivability_score: number | null
  factors: string[]
  geometry: LineString
  evidence: ApiHazardEvidence
}

export type ApiRoute = {
  route_id: string
  rank: number
  label: 'fastest' | 'balanced' | 'most_drivable' | 'distance_priority' | 'alternative'
  geometry: LineString
  segment_ids: string[]
  distance_m: number
  duration_s: number
  weighted_cost_s: number
  average_drivability_score: number | null
  minimum_drivability_score: number | null
  score_coverage: number
  minimum_confidence: number | null
  plowed_ratio: number
  snow_pipe_ratio: number
  hazard_group_count: number
  hazard_groups: ApiHazardGroup[]
  is_simulated: boolean
}

export type ApiDepartureCandidate = {
  offset_minutes: number
  departure_time: string
  minimum_plow_probability: number
  average_plow_probability: number
}

export type ApiDepartureRecommendation = {
  model_version: string
  is_prediction: boolean
  is_simulated: boolean
  basis: string
  evaluated_segment_ids: string[]
  recommended_offset_minutes: number
  recommended_departure_time: string
  meets_probability_threshold: boolean
  insufficient_data: boolean
  candidates: ApiDepartureCandidate[]
}

export type ApiRouteResponse = {
  request_id: string
  mode: 'time_priority' | 'balanced' | 'drivability_priority' | 'distance_priority' | 'comparison'
  reference_time: string
  graph_version: string
  score_rule_version: string
  cost_config_version: string
  data_timestamp: string
  is_simulated: boolean
  recommended_route_id?: string
  routes: ApiRoute[]
  departure_recommendation: ApiDepartureRecommendation
  warnings: string[]
}

export type RouteRecommendationResponse = {
  routes: RecommendedRoute[]
  generatedAt: string
  isSimulated: boolean
  apiResponse?: ApiRouteResponse
}

export type AssistantMetadata = {
  model_id: string
  fallback_used: boolean
  is_simulated: boolean
  data_timestamp: string | null
}

export type ParsedRouteRequest = {
  originQuery: string | null
  destinationQuery: string | null
  viaQueries: string[]
  priority: 'time' | 'balanced' | 'safety'
  avoidConditions: string[]
  preferConditions: string[]
  driverExperience: string
  missingFields: string[]
  needsConfirmation: boolean
  metadata: AssistantMetadata
}

export type RouteExplanation = {
  recommendedRouteId: string
  recommendationReason: string
  routes: Array<{
    routeId: string
    summary: string
    advantages: string[]
    cautions: string[]
  }>
  metadata: AssistantMetadata
}

export type DangerExplanation = {
  hazards: Array<{
    hazardId: string
    explanation: string
    cautions: string[]
  }>
  metadata: AssistantMetadata
}

export type ApiHealth = { status: string }

export type MapDataMeta = {
  schemaVersion: string
  dataTimestamp: string | null
  confidence: number
  isSimulated: boolean
  truncated: boolean
  source: 'api' | 'mock'
}

export type MapSnapshot = {
  roads: RoadSegmentFeatureCollection
  conditions: RoadCondition[]
  snowplows: Snowplow[]
  meta: MapDataMeta
}

export type MapRoadPage = {
  roads: RoadSegmentFeatureCollection
  conditions: RoadCondition[]
  meta: MapDataMeta
  nextCursor: string | null
}

export type ApiRoadProperties = {
  segment_id: string
  road_name: string | null
  road_type: string | null
  snow_pipe: boolean | null
  snow_pipe_operation_status: 'active' | 'inactive' | 'unknown' | null
  drivability_score: number | null
  length_m?: number | null
  max_slope_percent?: number | null
  snow_pipe_effectiveness?: number | null
  confidence?: number
  score_factors?: Record<string, number | boolean | string | null> | null
  score_rule_version?: string | null
  last_plowed_at?: string | null
  last_plowed_by?: string | null
  data_timestamp?: string | null
  source?: string | null
  is_simulated?: boolean
}

export type ApiRoadCollection = FeatureCollection<RoadGeometry, ApiRoadProperties> & {
  bbox: [number, number, number, number]
  count: number
  truncated: boolean
  next_cursor: string | null
  view?: 'detail' | 'map'
  data_timestamp: string | null
  confidence: number
  is_simulated: boolean
}

export type ApiSnowplowProperties = {
  vehicle_id: string
  display_name: string | null
  observed_at: string | null
  speed_kmh: number | null
  heading_degrees: number | null
  accuracy_m: number | null
  operation: string | null
  matched_segment_id: string | null
  match_distance_m: number | null
  run_id: string | null
  data_timestamp: string | null
  confidence: number
  is_simulated: boolean
}

export type ApiSnowplowCollection = FeatureCollection<Point, ApiSnowplowProperties> & {
  count: number
  data_timestamp: string | null
  confidence: number
  is_simulated: boolean
}

export type ApiMapSnapshot = {
  schema_version: '1.0'
  data_timestamp: string | null
  confidence: number
  is_simulated: boolean
  demo: { target_area: string; target_date: string }
  roads: ApiRoadCollection
  snowplows: ApiSnowplowCollection
}

export interface YukisakiApi {
  getHealth(signal?: AbortSignal): Promise<ApiHealth>
  getMapSnapshot(bounds?: MapBounds, signal?: AbortSignal): Promise<MapSnapshot>
  getMapRoadPage(bounds?: MapBounds, cursor?: string, signal?: AbortSignal, limit?: number, minRoadRank?: number): Promise<MapRoadPage>
  getRoadSegments(bounds?: MapBounds, signal?: AbortSignal): Promise<RoadSegmentFeatureCollection>
  getRoadSegment(segmentId: string, signal?: AbortSignal): Promise<{ road: RoadSegmentFeature; condition: RoadCondition }>
  getRoadConditions(segmentIds?: string[]): Promise<RoadCondition[]>
  getSnowmeltPipes(bounds?: MapBounds): Promise<SnowmeltPipeStatus[]>
  getSnowplows(bounds?: MapBounds, signal?: AbortSignal): Promise<Snowplow[]>
  getWeather(position: Position): Promise<WeatherData>
  autocompleteDestinations(query: string, signal?: AbortSignal): Promise<DestinationSuggestion[]>
  getDestinations(query: string): Promise<Destination[]>
  recommendRoutes(request: RouteRecommendationRequest): Promise<RouteRecommendationResponse>
  parseRouteRequest(text: string): Promise<ParsedRouteRequest>
  explainRoutes(routes: ApiRouteResponse): Promise<RouteExplanation>
  explainDangerPoints(routes: ApiRouteResponse, routeId: string): Promise<DangerExplanation>
}

export function isRoadFeatureCollection(value: unknown): value is RoadSegmentFeatureCollection {
  if (!value || typeof value !== 'object') return false
  const candidate = value as { type?: unknown; features?: unknown[] }
  return candidate.type === 'FeatureCollection' && Array.isArray(candidate.features) && candidate.features.every((feature) => {
    if (!feature || typeof feature !== 'object') return false
    const item = feature as { geometry?: { type?: unknown }; properties?: { segment_id?: unknown } }
    return (item.geometry?.type === 'LineString' || item.geometry?.type === 'MultiLineString') && typeof item.properties?.segment_id === 'string'
  })
}
