import { useEffect, useMemo, useRef, useState } from 'react'
import { appConfig } from '../../api/config'
import type { Destination, MapBounds, RecommendedRoute, RoadCondition, RoadSegmentFeature, RoadSegmentFeatureCollection, Snowplow } from '../../api/contracts'
import { loadMapKit } from './loadMapKit'

export type LayerVisibility = { drivability: boolean; snowmelt: boolean; plowing: boolean; plows: boolean; tracks: boolean; slopes: boolean; snowEffects: boolean }
type Props = {
  roads: RoadSegmentFeatureCollection
  conditions: RoadCondition[]
  snowplows: Snowplow[]
  layers: LayerVisibility
  destination?: Destination
  routes?: RecommendedRoute[]
  activeRouteId?: string
  onRoadSelect: (feature: RoadSegmentFeature) => void
  onPlowSelect: (plow: Snowplow) => void
  onMapDestination: (destination: Destination) => void
  onViewportChange: (bounds: MapBounds) => void
  animateSnowplows: boolean
}

type OverlayKind = 'road' | 'snow' | 'pipe' | 'plowing' | 'slope' | 'track' | 'route'
type OverlayData = { kind: OverlayKind; segmentId?: string; originalWidth?: number }
type AnnotationData = { kind: 'plow' | 'destination' | 'current'; id?: string }
type PlowCoordinate = [number, number]
type PlowMotion = { from: PlowCoordinate; to: PlowCoordinate; startedAt: number }
type OverviewChain = { key: string; coordinates: number[][]; color: string; segmentId?: string }
type ChainEndpoint = { chain: OverviewChain; coordinate: number[]; end: 'first' | 'last' }
type ChainGroup = { chains: OverviewChain[]; endpoints: Map<string, ChainEndpoint[]> }
type DesiredMapOverlay = {
  key: string
  kind: OverlayKind
  signature: string
  create: () => mapkit.Overlay
}
type ManagedMapOverlay = {
  kind: OverlayKind
  signature: string
  overlay: mapkit.Overlay
}
type RoadDisplay = {
  key: 'all' | 'local' | 'arterial' | 'primary' | 'trunk'
  minimumRank: number
  lineWidth: number
  bridgeMetres: number
  continuityBridgeMetres: number
  label?: string
}
const PLOW_INTERPOLATION_MS = 5_000
const PLOW_FRAME_INTERVAL_MS = 200
const MAX_INDIVIDUAL_ROAD_OVERLAYS = 3_000

function motionPosition(motion: PlowMotion, now: number, animate: boolean): PlowCoordinate {
  if (!animate) return motion.to
  const progressLinear = Math.min(1, Math.max(0, (now - motion.startedAt) / PLOW_INTERPOLATION_MS))
  const progress = progressLinear * progressLinear * (3 - 2 * progressLinear)
  return [motion.from[0] + (motion.to[0] - motion.from[0]) * progress, motion.from[1] + (motion.to[1] - motion.from[1]) * progress]
}

function colorForScore(score: number | undefined): string {
  if (score === undefined || !Number.isFinite(score)) return '#9cabb8'
  if (score < 60) return '#d73027'
  if (score < 75) return '#f28c28'
  if (score < 85) return '#f2d43d'
  return '#9be22d'
}

function roadRank(feature: RoadSegmentFeature): number {
  const roadType = (feature.properties.highway || '')
    .toLowerCase()
    .split(/[;,]/, 1)[0]
    .trim()
    .replace(/_link$/, '')
  if (roadType === 'motorway') return 6
  if (roadType === 'trunk') return 5
  if (roadType === 'primary') return 4
  if (roadType === 'secondary') return 3
  if (roadType === 'tertiary') return 2
  if (roadType === 'unclassified' || roadType === 'residential') return 1
  return 0
}

function roadDisplayForSpan(span: number): RoadDisplay {
  if (span <= 0.04) return { key: 'all', minimumRank: 0, lineWidth: 5, bridgeMetres: 10, continuityBridgeMetres: 10 }
  if (span <= 0.09) return { key: 'local', minimumRank: 1, lineWidth: 4.5, bridgeMetres: 35, continuityBridgeMetres: 90, label: '広域表示・生活道路以上' }
  if (span <= 0.18) return { key: 'arterial', minimumRank: 2, lineWidth: 4, bridgeMetres: 55, continuityBridgeMetres: 150, label: '広域表示・幹線道路中心' }
  if (span <= 0.36) return { key: 'primary', minimumRank: 3, lineWidth: 3.5, bridgeMetres: 80, continuityBridgeMetres: 240, label: '広域表示・主要道路のみ' }
  return { key: 'trunk', minimumRank: 4, lineWidth: 3, bridgeMetres: 110, continuityBridgeMetres: 360, label: '広域表示・主要幹線のみ' }
}

function linesOf(feature: RoadSegmentFeature): number[][][] {
  return feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates
}

function coordinatesOf(line: number[][]): mapkit.Coordinate[] {
  return line.flatMap(([longitude, latitude]) =>
    Number.isFinite(latitude) && Number.isFinite(longitude)
      ? [new mapkit.Coordinate(latitude, longitude)]
      : [],
  )
}

function offsetLine(line: number[][], metres = 3.5): number[][] {
  if (line.length < 2) return line
  return line.map(([longitude, latitude], index) => {
    const before = line[Math.max(0, index - 1)]
    const after = line[Math.min(line.length - 1, index + 1)]
    const dx = (after[0] - before[0]) * Math.cos(latitude * Math.PI / 180)
    const dy = after[1] - before[1]
    const length = Math.hypot(dx, dy)
    if (!length) return [longitude, latitude]
    const degrees = metres / 111_320
    return [
      longitude - (dy / length) * degrees / Math.max(0.2, Math.cos(latitude * Math.PI / 180)),
      latitude + (dx / length) * degrees,
    ]
  })
}

function distanceMetres([longitudeA, latitudeA]: number[], [longitudeB, latitudeB]: number[]): number {
  const latitude = (latitudeA + latitudeB) / 2 * Math.PI / 180
  const x = (longitudeB - longitudeA) * Math.cos(latitude)
  const y = latitudeB - latitudeA
  return Math.hypot(x, y) * 111_320
}

function overviewChains(
  roads: RoadSegmentFeatureCollection,
  conditionsById: Map<string, RoadCondition>,
  maximumGap: number,
  fixedColor?: string,
): OverviewChain[] {
  const grouped = new Map<string, ChainGroup>()
  const cellDegrees = maximumGap / 90_000
  const cellKey = (coordinate: number[], xOffset = 0, yOffset = 0) => (
    `${Math.floor(coordinate[0] / cellDegrees) + xOffset}:${Math.floor(coordinate[1] / cellDegrees) + yOffset}`
  )
  const indexEndpoint = (group: ChainGroup, chain: OverviewChain, end: 'first' | 'last') => {
    const coordinate = end === 'first' ? chain.coordinates[0] : chain.coordinates[chain.coordinates.length - 1]
    const key = cellKey(coordinate)
    const endpoints = group.endpoints.get(key) ?? []
    endpoints.push({ chain, coordinate, end })
    group.endpoints.set(key, endpoints)
  }
  const nearbyEndpoints = (group: ChainGroup, coordinate: number[]) => {
    const result: ChainEndpoint[] = []
    for (let yOffset = -1; yOffset <= 1; yOffset += 1) {
      for (let xOffset = -1; xOffset <= 1; xOffset += 1) {
        result.push(...(group.endpoints.get(cellKey(coordinate, xOffset, yOffset)) ?? []))
      }
    }
    return result.filter((endpoint) => {
      const current = endpoint.end === 'first'
        ? endpoint.chain.coordinates[0]
        : endpoint.chain.coordinates[endpoint.chain.coordinates.length - 1]
      return current[0] === endpoint.coordinate[0] && current[1] === endpoint.coordinate[1]
    })
  }

  roads.features.forEach((feature) => {
    const condition = conditionsById.get(feature.properties.segment_id)
    const score = condition?.hasDrivabilityScore === false ? undefined : condition?.drivabilityScore
    const color = fixedColor ?? colorForScore(score)
    const roadName = (feature.properties.road_name || feature.properties.name || '').trim()
    const identity = roadName.length > 0 ? roadName : feature.properties.highway || 'road'
    const groupKey = `${color}|${identity}`
    const group = grouped.get(groupKey) ?? { chains: [], endpoints: new Map<string, ChainEndpoint[]>() }
    if (!grouped.has(groupKey)) grouped.set(groupKey, group)

    linesOf(feature).forEach((sourceLine) => {
      const line = sourceLine.filter(([longitude, latitude]) => Number.isFinite(longitude) && Number.isFinite(latitude))
      if (line.length < 2) return
      let best: { chain: OverviewChain; mode: 'append' | 'append-reversed' | 'prepend' | 'prepend-reversed'; distance: number } | undefined

      nearbyEndpoints(group, line[0]).forEach((endpoint) => {
        const mode = endpoint.end === 'last' ? 'append' as const : 'prepend-reversed' as const
        const distance = distanceMetres(endpoint.coordinate, line[0])
        if (distance <= maximumGap && (!best || distance < best.distance)) {
          best = { chain: endpoint.chain, mode, distance }
        }
      })
      nearbyEndpoints(group, line[line.length - 1]).forEach((endpoint) => {
        const mode = endpoint.end === 'last' ? 'append-reversed' as const : 'prepend' as const
        const distance = distanceMetres(endpoint.coordinate, line[line.length - 1])
        if (distance <= maximumGap && (!best || distance < best.distance)) {
          best = { chain: endpoint.chain, mode, distance }
        }
      })

      if (!best) {
        const chain = {
          key: feature.properties.segment_id,
          coordinates: line,
          color,
          segmentId: feature.properties.segment_id,
        }
        group.chains.push(chain)
        indexEndpoint(group, chain, 'first')
        indexEndpoint(group, chain, 'last')
        return
      }

      const target = best.chain
      target.segmentId = undefined
      if (best.mode === 'append') target.coordinates = [...target.coordinates, ...line]
      if (best.mode === 'append-reversed') target.coordinates = [...target.coordinates, ...[...line].reverse()]
      if (best.mode === 'prepend') target.coordinates = [...line, ...target.coordinates]
      if (best.mode === 'prepend-reversed') target.coordinates = [...[...line].reverse(), ...target.coordinates]
      indexEndpoint(group, target, 'first')
      indexEndpoint(group, target, 'last')
    })
  })

  return [...grouped.values()].flatMap((group) => group.chains)
}

function coordinateOf(latitude: number, longitude: number): mapkit.Coordinate {
  return new mapkit.Coordinate(latitude, longitude)
}

function mapRegion(): mapkit.CoordinateRegion {
  const { minLongitude: west, minLatitude: south, maxLongitude: east, maxLatitude: north } = appConfig.demo.initialBounds
  return new mapkit.CoordinateRegion(
    new mapkit.Coordinate((south + north) / 2, (west + east) / 2),
    new mapkit.CoordinateSpan(north - south, east - west),
  )
}

function annotationElement(className: string, text?: string) {
  return () => {
    const element = document.createElement('div')
    element.className = `map-annotation ${className}`
    if (text) element.textContent = text
    return element
  }
}

function plowMarkerElement() {
  return () => {
    const element = document.createElement('div')
    element.className = 'map-annotation plow-marker'
    element.innerHTML = '<i class="marker-plow-body"><b class="marker-plow-cab"></b><b class="marker-plow-window"></b><b class="marker-plow-blade"></b><b class="marker-plow-wheel rear"></b><b class="marker-plow-wheel front"></b></i>'
    return element
  }
}

function dataOf(overlay: mapkit.Overlay | undefined): OverlayData | undefined {
  return overlay?.data as OverlayData | undefined
}

function lineSignature(line: number[][]): string {
  const first = line[0] ?? []
  const last = line[line.length - 1] ?? []
  return `${line.length}:${first.join(',')}:${last.join(',')}`
}

function reconcileMapOverlays(
  map: mapkit.Map,
  managed: Map<string, ManagedMapOverlay>,
  desired: DesiredMapOverlay[],
): { removed: mapkit.Overlay[]; groups: Partial<Record<OverlayKind, mapkit.Overlay[]>> } {
  const desiredByKey = new Map(desired.map((item) => [item.key, item]))
  const removed: mapkit.Overlay[] = []
  managed.forEach((current, key) => {
    const next = desiredByKey.get(key)
    if (next && next.signature === current.signature && next.kind === current.kind) return
    removed.push(current.overlay)
    managed.delete(key)
  })
  if (removed.length) map.removeOverlays(removed)

  const added: mapkit.Overlay[] = []
  desired.forEach((item) => {
    if (managed.has(item.key)) return
    const overlay = item.create()
    managed.set(item.key, { kind: item.kind, signature: item.signature, overlay })
    added.push(overlay)
  })
  if (added.length) map.addOverlays(added)

  const groups: Partial<Record<OverlayKind, mapkit.Overlay[]>> = {}
  managed.forEach(({ kind, overlay }) => {
    const overlays = groups[kind] ?? []
    overlays.push(overlay)
    groups[kind] = overlays
  })
  return { removed, groups }
}

function boundsOfRegion(region: mapkit.CoordinateRegion): MapBounds {
  const latitudeRadius = region.span.latitudeDelta / 2
  const longitudeRadius = region.span.longitudeDelta / 2
  return {
    minLongitude: region.center.longitude - longitudeRadius,
    minLatitude: region.center.latitude - latitudeRadius,
    maxLongitude: region.center.longitude + longitudeRadius,
    maxLatitude: region.center.latitude + latitudeRadius,
  }
}

function viewportKey(bounds: MapBounds): string {
  return [
    bounds.minLongitude, bounds.minLatitude,
    bounds.maxLongitude, bounds.maxLatitude,
  ].map((value) => value.toFixed(5)).join(',')
}

function regionSpan(region: mapkit.CoordinateRegion): number {
  return Math.max(Math.abs(region.span.latitudeDelta), Math.abs(region.span.longitudeDelta))
}

export function YukisakiMap(props: Props) {
  const { roads, conditions, snowplows, layers, destination, routes, activeRouteId, animateSnowplows } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapkit.Map | undefined>(undefined)
  const propsRef = useRef(props)
  const overlayGroupsRef = useRef<Record<OverlayKind, mapkit.Overlay[]>>({ road: [], snow: [], pipe: [], plowing: [], slope: [], track: [], route: [] })
  const managedMapOverlaysRef = useRef(new Map<string, ManagedMapOverlay>())
  const plowAnnotationsRef = useRef(new Map<string, mapkit.Annotation>())
  const destinationAnnotationRef = useRef<mapkit.Annotation | undefined>(undefined)
  const plowMotionsRef = useRef(new Map<string, PlowMotion>())
  const selectedOverlayRef = useRef<mapkit.Overlay | undefined>(undefined)
  const animationFrameRef = useRef<number | undefined>(undefined)
  const lastAnimationPaintRef = useRef(0)
  const [mapError, setMapError] = useState<string | undefined>(undefined)
  const [mapReady, setMapReady] = useState(false)
  const [roadDisplay, setRoadDisplay] = useState(() => {
    const bounds = appConfig.demo.initialBounds
    return roadDisplayForSpan(Math.max(
      bounds.maxLongitude - bounds.minLongitude,
      bounds.maxLatitude - bounds.minLatitude,
    ))
  })
  propsRef.current = props

  const conditionsById = useMemo(() => new Map(conditions.map((condition) => [condition.segmentId, condition])), [conditions])
  const visibleRoads = useMemo<RoadSegmentFeatureCollection>(() => ({
    type: 'FeatureCollection',
    features: roads.features.filter((feature) => roadRank(feature) >= roadDisplay.minimumRank),
  }), [roads, roadDisplay.minimumRank])

  useEffect(() => {
    let cancelled = false
    let viewportTimer: number | undefined
    let lastViewport = ''
    const container = containerRef.current
    if (!container) return

    const handleContextMenu = (event: MouseEvent) => {
      const map = mapRef.current
      if (!map) return
      event.preventDefault()
      const coordinate = map.convertPointOnPageToCoordinate(new DOMPoint(event.clientX, event.clientY))
      propsRef.current.onMapDestination({
        id: 'map-point', name: '地図で指定した地点', address: 'デモ道路内の指定地点',
        latitude: coordinate.latitude, longitude: coordinate.longitude,
      })
    }

    const handleRegionChange = () => {
      if (viewportTimer) window.clearTimeout(viewportTimer)
      viewportTimer = window.setTimeout(() => {
        const map = mapRef.current
        if (!map) return
        setRoadDisplay(roadDisplayForSpan(regionSpan(map.region)))
        const bounds = boundsOfRegion(map.region)
        const viewport = viewportKey(bounds)
        if (viewport === lastViewport) return
        lastViewport = viewport
        propsRef.current.onViewportChange(bounds)
      }, 750)
    }

    loadMapKit(appConfig.mapKitToken).then(() => {
      if (cancelled) return
      const map = new mapkit.Map(container, {
        region: mapRegion(),
        tintColor: '#176fc0',
        showsMapTypeControl: false,
        isRotationEnabled: false,
        showsZoomControl: true,
        showsPointsOfInterest: true,
      })
      mapRef.current = map
      lastViewport = viewportKey(boundsOfRegion(map.region))
      setMapReady(true)
      container.addEventListener('contextmenu', handleContextMenu)
      map.addEventListener('region-change-end', handleRegionChange)

      map.addEventListener('select', ((event: Event & { overlay?: mapkit.Overlay; annotation?: mapkit.Annotation }) => {
        if (event.overlay) {
          const data = dataOf(event.overlay)
          if (data?.kind !== 'road' || !data.segmentId) return
          const previous = selectedOverlayRef.current
          if (previous && previous !== event.overlay) {
            previous.style.lineWidth = dataOf(previous)?.originalWidth ?? 5
            previous.selected = false
          }
          event.overlay.style.lineWidth = 9
          selectedOverlayRef.current = event.overlay
          const feature = propsRef.current.roads.features.find((item) => item.properties.segment_id === data.segmentId)
          if (feature) propsRef.current.onRoadSelect(feature)
          return
        }
        const data = event.annotation?.data as AnnotationData | undefined
        if (data?.kind === 'plow' && data.id) {
          const plow = propsRef.current.snowplows.find((item) => item.id === data.id)
          if (plow) propsRef.current.onPlowSelect(plow)
        }
      }) as EventListener)

      const current = new mapkit.Annotation(
        coordinateOf(appConfig.demo.position.latitude, appConfig.demo.position.longitude),
        annotationElement('current-location-marker'),
        { data: { kind: 'current' } satisfies AnnotationData, enabled: false, accessibilityLabel: '現在地' },
      )
      map.addAnnotation(current)
      navigator.geolocation?.getCurrentPosition((position) => {
        current.coordinate = coordinateOf(position.coords.latitude, position.coords.longitude)
      }, () => undefined, { timeout: 5_000, maximumAge: 60_000 })

    }).catch((error: unknown) => {
      if (!cancelled) setMapError(error instanceof Error ? error.message : 'Apple Mapsを初期化できませんでした')
    })

    return () => {
      cancelled = true
      container.removeEventListener('contextmenu', handleContextMenu)
      if (viewportTimer) window.clearTimeout(viewportTimer)
      if (animationFrameRef.current) window.cancelAnimationFrame(animationFrameRef.current)
      mapRef.current?.removeEventListener('region-change-end', handleRegionChange)
      mapRef.current?.destroy()
      mapRef.current = undefined
      managedMapOverlaysRef.current.clear()
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const kinds: OverlayKind[] = ['road', 'snow', 'pipe', 'plowing', 'slope']
    const desired: DesiredMapOverlay[] = []

    const useChains = roadDisplay.key !== 'all' || visibleRoads.features.length > MAX_INDIVIDUAL_ROAD_OVERLAYS
    if (useChains) {
      const namedRoads: RoadSegmentFeatureCollection = {
        type: 'FeatureCollection',
        features: visibleRoads.features.filter((feature) => (
          (feature.properties.road_name || feature.properties.name || '').trim().length > 0
        )),
      }
      if (layers.drivability && roadDisplay.key !== 'all') {
        overviewChains(namedRoads, conditionsById, roadDisplay.continuityBridgeMetres, '#536879').forEach((chain) => {
          if (chain.coordinates.length < 2) return
          desired.push({
            key: `road:continuity:${chain.key}`,
            kind: 'road',
            signature: `${lineSignature(chain.coordinates)}:${chain.color}:${roadDisplay.lineWidth}`,
            create: () => new mapkit.PolylineOverlay(coordinatesOf(chain.coordinates), {
              data: { kind: 'road' } satisfies OverlayData,
              enabled: false,
              style: new mapkit.Style({
                strokeColor: chain.color,
                strokeOpacity: 0.42,
                lineWidth: roadDisplay.lineWidth + 2,
                lineCap: 'round',
                lineJoin: 'round',
              }),
            }),
          })
        })
      }
      if (layers.drivability) {
        overviewChains(visibleRoads, conditionsById, roadDisplay.bridgeMetres).forEach((chain) => {
          if (chain.coordinates.length < 2) return
          desired.push({
            key: `road:score:${chain.key}`,
            kind: 'road',
            signature: `${lineSignature(chain.coordinates)}:${chain.color}:${roadDisplay.lineWidth}:${chain.segmentId ?? ''}`,
            create: () => new mapkit.PolylineOverlay(coordinatesOf(chain.coordinates), {
              data: { kind: 'road', segmentId: chain.segmentId, originalWidth: roadDisplay.lineWidth } satisfies OverlayData,
              enabled: Boolean(chain.segmentId),
              style: new mapkit.Style({
                strokeColor: chain.color,
                strokeOpacity: 0.92,
                lineWidth: roadDisplay.lineWidth,
                lineCap: 'round',
                lineJoin: 'round',
              }),
            }),
          })
        })
      }
    } else {
      visibleRoads.features.forEach((feature) => {
        const segmentId = feature.properties.segment_id
        const condition = conditionsById.get(segmentId)
        const score = condition?.hasDrivabilityScore === false ? undefined : condition?.drivabilityScore
        linesOf(feature).forEach((line, lineIndex) => {
          if (line.length < 2) return
          const geometrySignature = lineSignature(line)
          if (layers.drivability) {
            const color = colorForScore(score)
            desired.push({
              key: `road:${segmentId}:${lineIndex}`,
              kind: 'road',
              signature: `${geometrySignature}:${color}:${roadDisplay.lineWidth}`,
              create: () => new mapkit.PolylineOverlay(coordinatesOf(line), {
                data: { kind: 'road', segmentId, originalWidth: roadDisplay.lineWidth } satisfies OverlayData,
                enabled: true,
                style: new mapkit.Style({ strokeColor: color, strokeOpacity: 0.96, lineWidth: roadDisplay.lineWidth, lineCap: 'round', lineJoin: 'round' }),
              }),
            })
          }
          if (layers.plowing && (condition?.status === 'recently_plowed' || condition?.status === 'plowed')) {
            desired.push({
              key: `plowing:${segmentId}:${lineIndex}`,
              kind: 'plowing',
              signature: geometrySignature,
              create: () => new mapkit.PolylineOverlay(coordinatesOf(line), {
                data: { kind: 'plowing', segmentId } satisfies OverlayData,
                enabled: false,
                style: new mapkit.Style({ strokeColor: '#142839', strokeOpacity: 0.45, lineWidth: 1.5, lineDash: [5, 5] }),
              }),
            })
          }
          if (layers.snowmelt && condition?.hasSnowmeltPipe) {
            const operating = condition.snowmeltPipeOperating
            desired.push({
              key: `pipe:${segmentId}:${lineIndex}`,
              kind: 'pipe',
              signature: `${geometrySignature}:${operating}`,
              create: () => new mapkit.PolylineOverlay(coordinatesOf(offsetLine(line)), {
                data: { kind: 'pipe', segmentId } satisfies OverlayData,
                enabled: false,
                style: new mapkit.Style({
                  strokeColor: operating ? '#13bde9' : '#1686c5',
                  strokeOpacity: 0.95,
                  lineWidth: 2.5,
                  lineDash: operating ? [4, 3] : [8, 5],
                }),
              }),
            })
          }
          if (layers.slopes && (condition?.slopePercent ?? 0) >= 7) {
            desired.push({
              key: `slope:${segmentId}:${lineIndex}`,
              kind: 'slope',
              signature: geometrySignature,
              create: () => new mapkit.PolylineOverlay(coordinatesOf(line), {
                data: { kind: 'slope', segmentId } satisfies OverlayData,
                enabled: false,
                style: new mapkit.Style({ strokeColor: '#dc4838', strokeOpacity: 1, lineWidth: 3, lineDash: [4, 4] }),
              }),
            })
          }
        })
      })
    }

    const { removed, groups } = reconcileMapOverlays(map, managedMapOverlaysRef.current, desired)
    if (selectedOverlayRef.current && removed.includes(selectedOverlayRef.current)) {
      selectedOverlayRef.current = undefined
    }
    kinds.forEach((kind) => {
      if (kind !== 'snow') overlayGroupsRef.current[kind] = groups[kind] ?? []
    })
  }, [visibleRoads, conditionsById, layers.drivability, layers.plowing, layers.slopes, layers.snowmelt, mapReady, roadDisplay])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (animationFrameRef.current) {
      window.cancelAnimationFrame(animationFrameRef.current)
      animationFrameRef.current = undefined
    }
    const now = performance.now()
    const activeIds = new Set(snowplows.map((plow) => plow.id))
    snowplows.forEach((plow) => {
      const previous = plowMotionsRef.current.get(plow.id)
      const from = previous ? motionPosition(previous, now, animateSnowplows) : [plow.longitude, plow.latitude] as PlowCoordinate
      plowMotionsRef.current.set(plow.id, { from, to: [plow.longitude, plow.latitude], startedAt: now })
      if (!plowAnnotationsRef.current.has(plow.id)) {
        const annotation = new mapkit.Annotation(
          coordinateOf(plow.latitude, plow.longitude),
          plowMarkerElement(),
          { title: plow.name, data: { kind: 'plow', id: plow.id } satisfies AnnotationData, accessibilityLabel: `${plow.name}（デモデータ）` },
        )
        plowAnnotationsRef.current.set(plow.id, annotation)
        map.addAnnotation(annotation)
      }
    })
    plowAnnotationsRef.current.forEach((annotation, id) => {
      if (!activeIds.has(id)) {
        map.removeAnnotation(annotation)
        plowAnnotationsRef.current.delete(id)
        plowMotionsRef.current.delete(id)
      }
    })

    if (overlayGroupsRef.current.track.length) map.removeOverlays(overlayGroupsRef.current.track)
    overlayGroupsRef.current.track = snowplows.flatMap((plow) => plow.track ? [new mapkit.PolylineOverlay(coordinatesOf(plow.track.coordinates), {
      data: { kind: 'track' } satisfies OverlayData,
      enabled: false,
      style: new mapkit.Style({ strokeColor: '#344a5e', strokeOpacity: 0.8, lineWidth: 5 }),
    })] : [])
    if (overlayGroupsRef.current.track.length) map.addOverlays(overlayGroupsRef.current.track)

    const motionEnabled = animateSnowplows && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (!motionEnabled) {
      snowplows.forEach((plow) => {
        const annotation = plowAnnotationsRef.current.get(plow.id)
        if (annotation) annotation.coordinate = coordinateOf(plow.latitude, plow.longitude)
      })
      return
    }

    lastAnimationPaintRef.current = 0
    const renderMotion = (frameNow: number) => {
      if (frameNow - lastAnimationPaintRef.current < PLOW_FRAME_INTERVAL_MS) {
        animationFrameRef.current = window.requestAnimationFrame(renderMotion)
        return
      }
      lastAnimationPaintRef.current = frameNow
      let hasActiveMotion = false
      plowAnnotationsRef.current.forEach((annotation, id) => {
        const motion = plowMotionsRef.current.get(id)
        if (!motion) return
        const [longitude, latitude] = motionPosition(motion, frameNow, true)
        annotation.coordinate = coordinateOf(latitude, longitude)
        if (frameNow - motion.startedAt < PLOW_INTERPOLATION_MS) hasActiveMotion = true
      })
      animationFrameRef.current = hasActiveMotion
        ? window.requestAnimationFrame(renderMotion)
        : undefined
    }
    animationFrameRef.current = window.requestAnimationFrame(renderMotion)

    return () => {
      if (animationFrameRef.current) {
        window.cancelAnimationFrame(animationFrameRef.current)
        animationFrameRef.current = undefined
      }
    }
  }, [snowplows, animateSnowplows, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (overlayGroupsRef.current.route.length) map.removeOverlays(overlayGroupsRef.current.route)
    overlayGroupsRef.current.route = (routes ?? []).map((route) => new mapkit.PolylineOverlay(coordinatesOf(route.geometry.coordinates), {
      data: { kind: 'route' } satisfies OverlayData,
      enabled: false,
      style: new mapkit.Style({
        strokeColor: route.id === 'fastest' ? '#ef6a3a' : route.id === 'recommended' ? '#236cc4' : '#168755',
        strokeOpacity: route.id === activeRouteId ? 0.95 : 0.28,
        lineWidth: route.id === activeRouteId ? 8 : 3,
      }),
    }))
    if (overlayGroupsRef.current.route.length) map.addOverlays(overlayGroupsRef.current.route)
  }, [routes, activeRouteId, mapReady])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    if (!destination) {
      if (destinationAnnotationRef.current) map.removeAnnotation(destinationAnnotationRef.current)
      destinationAnnotationRef.current = undefined
      return
    }
    if (!destinationAnnotationRef.current) {
      destinationAnnotationRef.current = new mapkit.Annotation(
        coordinateOf(destination.latitude, destination.longitude),
        annotationElement('destination-marker'),
        { title: destination.name, data: { kind: 'destination' } satisfies AnnotationData, enabled: false, accessibilityLabel: `目的地: ${destination.name}` },
      )
      map.addAnnotation(destinationAnnotationRef.current)
    } else {
      destinationAnnotationRef.current.coordinate = coordinateOf(destination.latitude, destination.longitude)
    }
  }, [destination, mapReady])

  useEffect(() => {
    const visibility: Record<OverlayKind, boolean> = {
      road: layers.drivability, snow: layers.snowEffects, pipe: layers.snowmelt,
      plowing: layers.plowing, slope: layers.slopes, track: layers.tracks, route: true,
    }
    ;(Object.entries(overlayGroupsRef.current) as Array<[OverlayKind, mapkit.Overlay[]]>).forEach(([kind, overlays]) => {
      overlays.forEach((overlay) => { overlay.visible = visibility[kind] })
    })
    plowAnnotationsRef.current.forEach((annotation) => { annotation.visible = layers.plows })
  }, [layers, roads, conditions, snowplows, routes, mapReady])

  return (
    <div className="map-canvas mapkit-canvas" aria-label="長岡市石動南町の道路状態地図">
      <div ref={containerRef} className="mapkit-host" />
      {mapError && <div className="map-error" role="alert"><b>Apple Mapsを表示できません</b><span>{mapError}</span></div>}
      {roadDisplay.label && <small className="map-overview-note">{roadDisplay.label}</small>}
      <small className="osm-attribution">道路データ © OpenStreetMap contributors</small>
    </div>
  )
}
