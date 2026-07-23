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
export type RoutePreference = 'fastest' | 'recommended' | 'snow-priority'
export type RouteRecommendationRequest = { origin: Position; destination: Position; preference: RoutePreference }
export type RecommendedRoute = {
  id: RoutePreference
  label: string
  durationMinutes: number
  distanceKm: number
  drivabilityScore: number
  plowedRatio: number
  snowmeltPipeRatio: number
  noPlowRecordSegmentCount: number
  hasNarrowRoad: boolean
  hasSteepSlope: boolean
  geometry: LineString
  warnings: string[]
  reasons: string[]
}
export type RouteRecommendationResponse = { routes: RecommendedRoute[]; generatedAt: string; isSimulated: boolean }

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
  length_m: number | null
  max_slope_percent: number | null
  snow_pipe: boolean | null
  snow_pipe_operation_status: 'active' | 'inactive' | 'unknown' | null
  snow_pipe_effectiveness: number | null
  drivability_score: number | null
  confidence: number
  score_factors: Record<string, number | boolean | string | null> | null
  score_rule_version: string | null
  last_plowed_at: string | null
  last_plowed_by: string | null
  data_timestamp: string | null
  source: string | null
  is_simulated: boolean
}

export type ApiRoadCollection = FeatureCollection<RoadGeometry, ApiRoadProperties> & {
  bbox: [number, number, number, number]
  count: number
  truncated: boolean
  next_cursor: string | null
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
  getMapSnapshot(bounds?: MapBounds, signal?: AbortSignal): Promise<MapSnapshot>
  getMapRoadPage(bounds?: MapBounds, cursor?: string, signal?: AbortSignal, limit?: number): Promise<MapRoadPage>
  getRoadSegments(bounds?: MapBounds, signal?: AbortSignal): Promise<RoadSegmentFeatureCollection>
  getRoadConditions(segmentIds?: string[]): Promise<RoadCondition[]>
  getSnowmeltPipes(bounds?: MapBounds): Promise<SnowmeltPipeStatus[]>
  getSnowplows(bounds?: MapBounds, signal?: AbortSignal): Promise<Snowplow[]>
  getWeather(position: Position): Promise<WeatherData>
  getDestinations(query: string): Promise<Destination[]>
  recommendRoutes(request: RouteRecommendationRequest): Promise<RouteRecommendationResponse>
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
