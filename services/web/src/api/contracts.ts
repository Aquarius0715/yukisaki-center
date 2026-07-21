import type { Feature, FeatureCollection, LineString } from 'geojson'

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
}

export type RoadSegmentFeature = Feature<LineString, RoadSegmentProperties>
export type RoadSegmentFeatureCollection = FeatureCollection<LineString, RoadSegmentProperties>
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
  status: RoadConditionStatus
  scoreBreakdown: ScoreBreakdown
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
  todayDistanceKm: number
  track: LineString
  plannedRoute?: LineString
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

export interface YukisakiApi {
  getRoadSegments(bounds?: MapBounds): Promise<RoadSegmentFeatureCollection>
  getRoadConditions(segmentIds?: string[]): Promise<RoadCondition[]>
  getSnowmeltPipes(bounds?: MapBounds): Promise<SnowmeltPipeStatus[]>
  getSnowplows(bounds?: MapBounds): Promise<Snowplow[]>
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
    return item.geometry?.type === 'LineString' && typeof item.properties?.segment_id === 'string'
  })
}
