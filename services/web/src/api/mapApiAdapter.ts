import type { Position } from 'geojson'
import type {
  ApiMapSnapshot,
  ApiRoadCollection,
  ApiRoadProperties,
  ApiSnowplowCollection,
  MapSnapshot,
  RoadCondition,
  RoadConditionStatus,
  RoadSegmentFeature,
  RoadSegmentFeatureCollection,
  Snowplow,
} from './contracts'

const factorLabels: Record<string, string> = {
  steep_slope: '急な坂道による補正',
  moderate_slope: '坂道による補正',
  plowed_within_60_minutes: '60分以内に除雪車が通過',
  plowed_60_to_180_minutes_ago: '除雪車通過から時間が経過',
  plowed_over_180_minutes_ago: '除雪情報が古くなっています',
  no_plow_history: '除雪車の走行実績を確認できません',
  active_snow_pipe: '消雪パイプ作動中',
  freezing_wet_condition: '気象・路面入力による補正',
  heavy_hourly_snowfall: '気象入力による補正',
  moderate_hourly_snowfall: '気象入力による補正',
  light_hourly_snowfall: '気象入力による補正',
}

function coordinates(geometry: RoadSegmentFeature['geometry']): Position[] {
  return geometry.type === 'LineString' ? geometry.coordinates : geometry.coordinates.flat()
}

function statusOf(properties: ApiRoadProperties): RoadConditionStatus {
  const factors = properties.score_factors ?? {}
  if ('steep_slope' in factors) return 'warning'
  if (properties.snow_pipe && properties.snow_pipe_operation_status === 'active') return 'snowmelt'
  if (!properties.last_plowed_at || 'no_plow_history' in factors) return 'no_plow_record'
  if ('plowed_over_180_minutes_ago' in factors || 'plowed_60_to_180_minutes_ago' in factors) return 'stale_plow_data'
  if ('plowed_within_60_minutes' in factors) return 'recently_plowed'
  return 'plowed'
}

function factorMessages(factors: ApiRoadProperties['score_factors']) {
  return Object.entries(factors ?? {}).map(([key, value]) => ({
    key,
    label: factorLabels[key] ?? key.split('_').join(' '),
    value,
  }))
}

function adaptRoadFeature(feature: ApiRoadCollection['features'][number]): RoadSegmentFeature {
  const input = feature.properties
  const points = coordinates(feature.geometry)
  const start = points[0] ?? [0, 0]
  const end = points[points.length - 1] ?? start
  return {
    type: 'Feature',
    id: input.segment_id,
    geometry: feature.geometry,
    properties: {
      segment_id: input.segment_id,
      source_edge_id: null,
      osm_id: null,
      osmid: null,
      road_name: input.road_name,
      name: input.road_name,
      highway: input.road_type,
      oneway: null,
      maxspeed: null,
      lanes: null,
      lanes_forward: null,
      lanes_backward: null,
      surface: null,
      width: null,
      bridge: null,
      tunnel: null,
      segment_index: 0,
      segment_count: 1,
      length_m: input.length_m ?? 0,
      start_lon: start[0] ?? 0,
      start_lat: start[1] ?? 0,
      end_lon: end[0] ?? 0,
      end_lat: end[1] ?? 0,
      confidence: input.confidence,
      data_timestamp: input.data_timestamp,
      is_simulated: input.is_simulated,
    },
  }
}

function adaptCondition(properties: ApiRoadProperties): RoadCondition {
  const score = properties.drivability_score ?? 0
  const messages = factorMessages(properties.score_factors)
  const warnings = messages.filter(({ key, value }) => key === 'no_plow_history' || key === 'steep_slope' || (typeof value === 'number' && value < 0)).map(({ label }) => label)
  const reasons = messages.filter(({ key, value }) => key !== 'no_plow_history' && key !== 'steep_slope' && (typeof value !== 'number' || value >= 0)).map(({ label }) => label)
  return {
    segmentId: properties.segment_id,
    hasSnowmeltPipe: properties.snow_pipe === true,
    snowmeltPipeOperating: properties.snow_pipe_operation_status === 'active',
    lastPlowedAt: properties.last_plowed_at,
    plowVehicleId: properties.last_plowed_by,
    roadWidthM: null,
    slopePercent: properties.max_slope_percent,
    drivabilityScore: score,
    hasDrivabilityScore: properties.drivability_score !== null,
    status: statusOf(properties),
    scoreBreakdown: { base: 0, snowmeltPipe: 0, snowmeltPipeOperation: 0, recentPlowing: 0, roadClass: 0, roadWidth: 0, slope: 0, dataFreshness: 0, finalScore: score },
    scoreFactors: properties.score_factors ?? {},
    scoreFactorDetails: messages.map(({ label, value }) => ({ label, value })),
    reasons,
    warnings,
    updatedAt: properties.data_timestamp ?? '',
    isSimulated: properties.is_simulated,
  }
}

export function adaptRoads(collection: ApiRoadCollection): { roads: RoadSegmentFeatureCollection; conditions: RoadCondition[] } {
  return {
    roads: { type: 'FeatureCollection', features: collection.features.map(adaptRoadFeature) },
    conditions: collection.features.map((feature) => adaptCondition(feature.properties)),
  }
}

export function adaptSnowplows(collection: ApiSnowplowCollection): Snowplow[] {
  return collection.features.map((feature) => {
    const [longitude = 0, latitude = 0] = feature.geometry.coordinates
    const operation = feature.properties.operation
    return {
      id: feature.properties.vehicle_id,
      name: feature.properties.display_name ?? feature.properties.vehicle_id,
      status: operation === 'plowing' || operation === 'snow_removal' ? 'working' : operation === 'moving' ? 'moving' : 'stopped',
      latitude,
      longitude,
      heading: feature.properties.heading_degrees ?? 0,
      speedKmh: feature.properties.speed_kmh ?? 0,
      lastUpdatedAt: feature.properties.observed_at ?? feature.properties.data_timestamp ?? '',
      todayDistanceKm: null,
      matchedSegmentId: feature.properties.matched_segment_id,
      confidence: feature.properties.confidence,
      isSimulated: feature.properties.is_simulated,
    }
  })
}

export function adaptSnapshot(snapshot: ApiMapSnapshot): MapSnapshot {
  const { roads, conditions } = adaptRoads(snapshot.roads)
  return {
    roads,
    conditions,
    snowplows: adaptSnowplows(snapshot.snowplows),
    meta: {
      schemaVersion: snapshot.schema_version,
      dataTimestamp: snapshot.data_timestamp,
      confidence: snapshot.confidence,
      isSimulated: snapshot.is_simulated,
      truncated: snapshot.roads.truncated,
      source: 'api',
    },
  }
}

export function isApiMapSnapshot(value: unknown): value is ApiMapSnapshot {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ApiMapSnapshot>
  return item.schema_version === '1.0' && isApiRoadCollection(item.roads) && isApiSnowplowCollection(item.snowplows)
}

export function isApiRoadCollection(value: unknown): value is ApiRoadCollection {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ApiRoadCollection>
  return item.type === 'FeatureCollection' && Array.isArray(item.features) && item.features.every((feature) =>
    Boolean(feature?.properties && typeof feature.properties.segment_id === 'string' && (feature.geometry?.type === 'LineString' || feature.geometry?.type === 'MultiLineString')),
  )
}

export function isApiSnowplowCollection(value: unknown): value is ApiSnowplowCollection {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<ApiSnowplowCollection>
  return item.type === 'FeatureCollection' && Array.isArray(item.features) && item.features.every((feature) =>
    Boolean(feature?.properties && typeof feature.properties.vehicle_id === 'string' && feature.geometry?.type === 'Point'),
  )
}
