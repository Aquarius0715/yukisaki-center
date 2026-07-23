import { appConfig } from '../../api/config'
import { requestJson } from '../../api/client'
import { isRoadFeatureCollection, type Destination, type RoadCondition, type RoadSegmentFeatureCollection, type RecommendedRoute, type RouteRecommendationRequest, type Snowplow, type YukisakiApi } from '../../api/contracts'

let roadsPromise: Promise<RoadSegmentFeatureCollection> | undefined
const generatedAt = '2026-01-23T12:00:00+09:00'
const roadUrl = () => new URL('data/road-segments.geojson', document.baseURI).toString()

function hashString(value: string): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) { hash = Math.imul(31, hash) + value.charCodeAt(index); hash |= 0 }
  return Math.abs(hash)
}

async function loadRoads() {
  roadsPromise ??= requestJson<unknown>(roadUrl()).then((value) => {
    if (!isRoadFeatureCollection(value)) throw new Error('道路GeoJSONの形式が正しくありません。')
    return value
  })
  return roadsPromise
}

function conditionFor(segmentId: string, highway: string | null, widthValue: string | number | null): RoadCondition {
  const seed = hashString(segmentId)
  const major = ['trunk', 'primary', 'secondary', 'tertiary'].includes(highway ?? '')
  const width = Number(widthValue) || (major ? 7 : 3.8)
  const hasPipe = seed % (major ? 3 : 7) !== 0
  const operating = hasPipe && seed % 5 !== 0
  const noRecord = seed % (major ? 9 : 4) === 0
  const minutesAgo = noRecord ? null : 8 + seed % 260
  const stale = minutesAgo !== null && minutesAgo > 150
  const narrow = width < 4.2
  const slope = (seed % 90) / 10
  const base = 55
  const snowmeltPipe = hasPipe ? 6 : 0
  const snowmeltPipeOperation = operating ? 12 : 0
  const recentPlowing = minutesAgo === null ? 0 : minutesAgo < 45 ? 18 : minutesAgo < 150 ? 8 : 0
  const roadClass = major ? 8 : highway === 'service' ? -5 : 0
  const roadWidth = width >= 6 ? 5 : narrow ? -8 : 0
  const slopeScore = slope >= 7 ? -10 : slope >= 5 ? -5 : 0
  const dataFreshness = noRecord ? -12 : stale ? -8 : 0
  const finalScore = Math.max(0, Math.min(100, base + snowmeltPipe + snowmeltPipeOperation + recentPlowing + roadClass + roadWidth + slopeScore + dataFreshness))
  const warnings = [narrow ? '狭い道路のため注意' : '', slope >= 7 ? '急な坂道のため注意' : '', stale ? '除雪情報が古くなっています' : '', noRecord ? '除雪車の走行実績を確認できません' : ''].filter(Boolean)
  const status = narrow || slope >= 7 ? 'warning' : operating ? 'snowmelt' : noRecord ? 'no_plow_record' : stale ? 'stale_plow_data' : minutesAgo! < 45 ? 'recently_plowed' : 'plowed'
  return {
    segmentId, hasSnowmeltPipe: hasPipe, snowmeltPipeOperating: operating,
    lastPlowedAt: minutesAgo === null ? null : new Date(new Date(generatedAt).getTime() - minutesAgo * 60_000).toISOString(),
    plowVehicleId: noRecord ? null : `plow-${(seed % 3) + 1}`, roadWidthM: width, slopePercent: slope,
    drivabilityScore: finalScore, status, updatedAt: generatedAt, isSimulated: true, warnings,
    reasons: [operating ? '消雪パイプ作動中' : hasPipe ? '消雪パイプは停止中' : '', minutesAgo !== null ? `${minutesAgo}分前に除雪車が通過` : '', major ? '幹線道路' : '', width >= 6 ? '道幅が広い' : ''].filter(Boolean),
    scoreBreakdown: { base, snowmeltPipe, snowmeltPipeOperation, recentPlowing, roadClass, roadWidth, slope: slopeScore, dataFreshness, finalScore },
  } as RoadCondition
}

const destinations: Destination[] = [
  { id: 'station', name: '長岡駅', address: '長岡市城内町', latitude: 37.4477, longitude: 138.7912 },
  { id: 'gidaidai', name: '長岡技術科学大学', address: '長岡市上富岡町', latitude: 37.4249, longitude: 138.7784 },
  { id: 'aore', name: 'アオーレ長岡', address: '長岡市大手通', latitude: 37.4468, longitude: 138.8512 },
  { id: 'demo-east', name: '石動南町 東口', address: 'デモ道路内の地点', latitude: 37.4454, longitude: 138.7950 },
]

const plows: Snowplow[] = [
  { id: 'plow-1', name: '除雪車 01', status: 'working', latitude: 37.4437, longitude: 138.7908, heading: 0, speedKmh: 18, lastUpdatedAt: generatedAt, todayDistanceKm: 12.4, track: { type: 'LineString', coordinates: [[138.7908,37.4402],[138.7908,37.4437]] }, plannedRoute: { type: 'LineString', coordinates: [[138.7908,37.4437],[138.7908,37.4470]] }, isSimulated: true },
  { id: 'plow-2', name: '除雪車 02', status: 'moving', latitude: 37.4454, longitude: 138.7934, heading: 90, speedKmh: 12, lastUpdatedAt: generatedAt, todayDistanceKm: 8.7, track: { type: 'LineString', coordinates: [[138.7870,37.4454],[138.7934,37.4454]] }, plannedRoute: { type: 'LineString', coordinates: [[138.7934,37.4454],[138.7960,37.4454]] }, isSimulated: true },
  { id: 'plow-3', name: '除雪車 03', status: 'stopped', latitude: 37.4418, longitude: 138.7950, heading: 180, speedKmh: 0, lastUpdatedAt: generatedAt, todayDistanceKm: 6.1, track: { type: 'LineString', coordinates: [[138.7950,37.4454],[138.7950,37.4418]] }, isSimulated: true },
]

function routeGeometry(destination: Destination, variant: number) {
  const start = [appConfig.demo.position.longitude, appConfig.demo.position.latitude]
  const end = [destination.longitude, destination.latitude]
  const dx = variant === 0 ? 0 : variant === 1 ? 0.0013 : -0.0013
  return { type: 'LineString' as const, coordinates: [start, [start[0] + dx, 37.4454], [end[0] + dx, 37.4454], end] }
}

export class MockYukisakiApi implements YukisakiApi {
  async getMapSnapshot() {
    const roads = await this.getRoadSegments()
    const conditions = await this.getRoadConditions()
    return {
      roads,
      conditions,
      snowplows: await this.getSnowplows(),
      meta: { schemaVersion: '1.0', dataTimestamp: generatedAt, confidence: 0.8, isSimulated: true, truncated: false, source: 'mock' as const },
    }
  }
  private async roadsIn(bounds?: Parameters<YukisakiApi['getRoadSegments']>[0]) {
    const source = await loadRoads()
    const features = bounds ? source.features.filter((feature) => {
      const points = feature.geometry.type === 'LineString' ? feature.geometry.coordinates : feature.geometry.coordinates.flat()
      return points.some(([longitude, latitude]) =>
        longitude >= bounds.minLongitude && longitude <= bounds.maxLongitude &&
        latitude >= bounds.minLatitude && latitude <= bounds.maxLatitude)
    }) : source.features
    return { ...source, features }
  }
  async getMapRoadPage(bounds?: Parameters<YukisakiApi['getRoadSegments']>[0]) {
    const roads = await this.roadsIn(bounds)
    const conditions = roads.features.map((feature) => conditionFor(feature.properties.segment_id, feature.properties.highway, feature.properties.width))
    return {
      roads,
      conditions,
      meta: { schemaVersion: '1.0', dataTimestamp: generatedAt, confidence: 0.8, isSimulated: true, truncated: false, source: 'mock' as const },
      nextCursor: null,
    }
  }
  getRoadSegments(bounds?: Parameters<YukisakiApi['getRoadSegments']>[0]) { return this.roadsIn(bounds) }
  async getRoadConditions(segmentIds?: string[]) {
    const roads = await loadRoads()
    return roads.features.filter((feature) => !segmentIds || segmentIds.includes(feature.properties.segment_id)).map((feature) => conditionFor(feature.properties.segment_id, feature.properties.highway, feature.properties.width))
  }
  async getSnowmeltPipes() { return (await this.getRoadConditions()).map((condition) => ({ segmentId: condition.segmentId, installed: condition.hasSnowmeltPipe, operating: condition.snowmeltPipeOperating, lastUpdatedAt: condition.updatedAt })) }
  async getSnowplows() { return plows }
  async getWeather() { return { temperatureC: -1, condition: '雪', observedAt: generatedAt, isSimulated: true } }
  async getDestinations(query: string) { const normalized = query.trim().toLocaleLowerCase('ja'); return destinations.filter((item) => !normalized || `${item.name}${item.address}`.toLocaleLowerCase('ja').includes(normalized)) }
  async recommendRoutes(request: RouteRecommendationRequest) {
    const destination = destinations.find((item) => item.latitude === request.destination.latitude && item.longitude === request.destination.longitude) ?? { id: 'map', name: '地図で指定した地点', address: 'デモ道路内', ...request.destination }
    const specs: Omit<RecommendedRoute, 'geometry'>[] = [
      { id: 'fastest', label: '最速ルート', durationMinutes: 15, distanceKm: 5.4, drivabilityScore: 58, plowedRatio: .54, snowmeltPipeRatio: .18, noPlowRecordSegmentCount: 8, hasNarrowRoad: true, hasSteepSlope: false, warnings: ['狭い道路があります','除雪車の走行実績を確認できない区間があります'], reasons: ['所要時間を優先しています'] },
      { id: 'recommended', label: 'おすすめルート', durationMinutes: 18, distanceKm: 6.2, drivabilityScore: 86, plowedRatio: .92, snowmeltPipeRatio: .64, noPlowRecordSegmentCount: 0, hasNarrowRoad: false, hasSteepSlope: false, warnings: [], reasons: ['直近に除雪車が通過した道路を優先','消雪パイプ区間を多く利用'] },
      { id: 'snow-priority', label: '雪道優先ルート', durationMinutes: 22, distanceKm: 7.1, drivabilityScore: 93, plowedRatio: .97, snowmeltPipeRatio: .78, noPlowRecordSegmentCount: 0, hasNarrowRoad: false, hasSteepSlope: false, warnings: [], reasons: ['消雪パイプ区間を最優先','幹線道路を優先'] },
    ]
    return { routes: specs.map((route, index) => ({ ...route, geometry: routeGeometry(destination, index) })), generatedAt, isSimulated: true }
  }
}

export { hashString }
