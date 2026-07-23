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
  onDetailModeChange: (enabled: boolean) => void
  animateSnowplows: boolean
}

type OverlayKind = 'road' | 'snow' | 'pipe' | 'plowing' | 'slope' | 'track' | 'route'
type OverlayData = { kind: OverlayKind; segmentId?: string; originalWidth?: number }
type AnnotationData = { kind: 'plow' | 'destination' | 'current'; id?: string }
type PlowCoordinate = [number, number]
type PlowMotion = { from: PlowCoordinate; to: PlowCoordinate; startedAt: number }
const PLOW_INTERPOLATION_MS = 5_000
const DETAIL_SPAN_THRESHOLD = 0.075
const VIEWPORT_PADDING = 0.18

function motionPosition(motion: PlowMotion, now: number, animate: boolean): PlowCoordinate {
  if (!animate) return motion.to
  const progressLinear = Math.min(1, Math.max(0, (now - motion.startedAt) / PLOW_INTERPOLATION_MS))
  const progress = progressLinear * progressLinear * (3 - 2 * progressLinear)
  return [motion.from[0] + (motion.to[0] - motion.from[0]) * progress, motion.from[1] + (motion.to[1] - motion.from[1]) * progress]
}

function colorForScore(score: number | undefined): string {
  if (score === undefined || !Number.isFinite(score)) return '#9cabb8'
  if (score < 60) return '#d73027'
  if (score < 75) return '#f0a72f'
  if (score < 85) return '#55a9d6'
  return '#176fc0'
}

function linesOf(feature: RoadSegmentFeature): number[][][] {
  return feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates
}

function coordinatesOf(line: number[][]): mapkit.CoordinateData[] {
  return line.map(([longitude, latitude]) => ({ latitude, longitude }))
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

function viewportOf(region: mapkit.CoordinateRegion): { bounds: MapBounds; detailed: boolean } {
  const latitudeDelta = Math.abs(region.span.latitudeDelta)
  const longitudeDelta = Math.abs(region.span.longitudeDelta)
  const detailed = Math.max(latitudeDelta, longitudeDelta) <= DETAIL_SPAN_THRESHOLD
  const latitudePadding = latitudeDelta * VIEWPORT_PADDING
  const longitudePadding = longitudeDelta * VIEWPORT_PADDING
  return {
    detailed,
    bounds: {
      minLongitude: region.center.longitude - longitudeDelta / 2 - longitudePadding,
      minLatitude: region.center.latitude - latitudeDelta / 2 - latitudePadding,
      maxLongitude: region.center.longitude + longitudeDelta / 2 + longitudePadding,
      maxLatitude: region.center.latitude + latitudeDelta / 2 + latitudePadding,
    },
  }
}

function mapRegion(roads: RoadSegmentFeatureCollection): mapkit.CoordinateRegion {
  const coordinates = roads.features.flatMap((feature) => linesOf(feature).flat())
  if (!coordinates.length) {
    return new mapkit.CoordinateRegion(
      new mapkit.Coordinate(appConfig.demo.position.latitude, appConfig.demo.position.longitude),
      new mapkit.CoordinateSpan(0.05, 0.05),
    )
  }
  const longitudes = coordinates.map(([longitude]) => longitude)
  const latitudes = coordinates.map(([, latitude]) => latitude)
  const west = Math.min(...longitudes)
  const east = Math.max(...longitudes)
  const south = Math.min(...latitudes)
  const north = Math.max(...latitudes)
  return new mapkit.CoordinateRegion(
    new mapkit.Coordinate((south + north) / 2, (west + east) / 2),
    new mapkit.CoordinateSpan(Math.max(0.01, (north - south) * 1.15), Math.max(0.01, (east - west) * 1.15)),
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

function dataOf(overlay: mapkit.Overlay | undefined): OverlayData | undefined {
  return overlay?.data as OverlayData | undefined
}

export function YukisakiMap(props: Props) {
  const { roads, conditions, snowplows, layers, destination, routes, activeRouteId, animateSnowplows } = props
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<mapkit.Map | undefined>(undefined)
  const propsRef = useRef(props)
  const overlayGroupsRef = useRef<Record<OverlayKind, mapkit.Overlay[]>>({ road: [], snow: [], pipe: [], plowing: [], slope: [], track: [], route: [] })
  const plowAnnotationsRef = useRef(new Map<string, mapkit.Annotation>())
  const destinationAnnotationRef = useRef<mapkit.Annotation | undefined>(undefined)
  const plowMotionsRef = useRef(new Map<string, PlowMotion>())
  const selectedOverlayRef = useRef<mapkit.Overlay | undefined>(undefined)
  const animationFrameRef = useRef<number | undefined>(undefined)
  const [mapError, setMapError] = useState<string | undefined>(undefined)
  const [mapReady, setMapReady] = useState(false)
  const [detailMode, setDetailMode] = useState(true)
  propsRef.current = props

  const conditionsById = useMemo(() => new Map(conditions.map((condition) => [condition.segmentId, condition])), [conditions])

  useEffect(() => {
    let cancelled = false
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

    loadMapKit(appConfig.mapKitToken).then(() => {
      if (cancelled) return
      const map = new mapkit.Map(container, {
        region: mapRegion(propsRef.current.roads),
        tintColor: '#176fc0',
        showsMapTypeControl: false,
        isRotationEnabled: false,
        showsZoomControl: true,
        showsPointsOfInterest: true,
      })
      mapRef.current = map
      setMapReady(true)
      container.addEventListener('contextmenu', handleContextMenu)

      let viewportTimer: number | undefined
      const handleRegionChange = () => {
        window.clearTimeout(viewportTimer)
        viewportTimer = window.setTimeout(() => {
          const viewport = viewportOf(map.region)
          setDetailMode(viewport.detailed)
          propsRef.current.onDetailModeChange(viewport.detailed)
          if (viewport.detailed) propsRef.current.onViewportChange(viewport.bounds)
        }, 350)
      }
      map.addEventListener('region-change-end', handleRegionChange)
      handleRegionChange()

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
        appConfig.demo.position,
        annotationElement('current-location-marker'),
        { data: { kind: 'current' } satisfies AnnotationData, enabled: false, accessibilityLabel: '現在地' },
      )
      map.addAnnotation(current)
      navigator.geolocation?.getCurrentPosition((position) => {
        current.coordinate = { latitude: position.coords.latitude, longitude: position.coords.longitude }
      }, () => undefined, { timeout: 5_000, maximumAge: 60_000 })

      const renderMotion = (now: number) => {
        const motionEnabled = propsRef.current.animateSnowplows && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
        plowAnnotationsRef.current.forEach((annotation, id) => {
          const motion = plowMotionsRef.current.get(id)
          if (!motion) return
          const [longitude, latitude] = motionPosition(motion, now, motionEnabled)
          annotation.coordinate = { latitude, longitude }
        })
        animationFrameRef.current = window.requestAnimationFrame(renderMotion)
      }
      animationFrameRef.current = window.requestAnimationFrame(renderMotion)
    }).catch((error: unknown) => {
      if (!cancelled) setMapError(error instanceof Error ? error.message : 'Apple Mapsを初期化できませんでした')
    })

    return () => {
      cancelled = true
      container.removeEventListener('contextmenu', handleContextMenu)
      if (animationFrameRef.current) window.cancelAnimationFrame(animationFrameRef.current)
      mapRef.current?.destroy()
      mapRef.current = undefined
    }
  }, [])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const kinds: OverlayKind[] = ['road', 'snow', 'pipe', 'plowing', 'slope']
    const old = kinds.flatMap((kind) => overlayGroupsRef.current[kind])
    if (old.length) map.removeOverlays(old)
    kinds.forEach((kind) => { overlayGroupsRef.current[kind] = [] })
    if (!detailMode) return

    roads.features.forEach((feature) => {
      const segmentId = feature.properties.segment_id
      const condition = conditionsById.get(segmentId)
      const score = condition?.hasDrivabilityScore === false ? undefined : condition?.drivabilityScore
      linesOf(feature).forEach((line) => {
        const points = coordinatesOf(line)
        if (points.length < 2) return
        overlayGroupsRef.current.snow.push(new mapkit.PolylineOverlay(points, {
          data: { kind: 'snow', segmentId } satisfies OverlayData,
          enabled: false,
          style: new mapkit.Style({ strokeColor: '#ffffff', strokeOpacity: 0.82, lineWidth: 10, lineCap: 'round', lineJoin: 'round' }),
        }))
        overlayGroupsRef.current.road.push(new mapkit.PolylineOverlay(points, {
          data: { kind: 'road', segmentId, originalWidth: 5 } satisfies OverlayData,
          enabled: true,
          style: new mapkit.Style({ strokeColor: colorForScore(score), strokeOpacity: 0.96, lineWidth: 5, lineCap: 'round', lineJoin: 'round' }),
        }))
        if (condition?.status === 'recently_plowed' || condition?.status === 'plowed') {
          overlayGroupsRef.current.plowing.push(new mapkit.PolylineOverlay(points, {
            data: { kind: 'plowing', segmentId } satisfies OverlayData,
            enabled: false,
            style: new mapkit.Style({ strokeColor: '#142839', strokeOpacity: 0.45, lineWidth: 1.5, lineDash: [5, 5] }),
          }))
        }
        if (condition?.hasSnowmeltPipe) {
          overlayGroupsRef.current.pipe.push(new mapkit.PolylineOverlay(coordinatesOf(offsetLine(line)), {
            data: { kind: 'pipe', segmentId } satisfies OverlayData,
            enabled: false,
            style: new mapkit.Style({
              strokeColor: condition.snowmeltPipeOperating ? '#13bde9' : '#1686c5',
              strokeOpacity: 0.95,
              lineWidth: 2.5,
              lineDash: condition.snowmeltPipeOperating ? [4, 3] : [8, 5],
            }),
          }))
        }
        if ((condition?.slopePercent ?? 0) >= 7) {
          overlayGroupsRef.current.slope.push(new mapkit.PolylineOverlay(points, {
            data: { kind: 'slope', segmentId } satisfies OverlayData,
            enabled: false,
            style: new mapkit.Style({ strokeColor: '#dc4838', strokeOpacity: 1, lineWidth: 3, lineDash: [4, 4] }),
          }))
        }
      })
    })

    map.addOverlays([
      ...overlayGroupsRef.current.snow,
      ...overlayGroupsRef.current.road,
      ...overlayGroupsRef.current.plowing,
      ...overlayGroupsRef.current.pipe,
      ...overlayGroupsRef.current.slope,
    ])
  }, [roads, conditionsById, mapReady, detailMode])

  useEffect(() => {
    const map = mapRef.current
    if (!map) return
    const now = performance.now()
    const activeIds = new Set(snowplows.map((plow) => plow.id))
    snowplows.forEach((plow) => {
      const previous = plowMotionsRef.current.get(plow.id)
      const from = previous ? motionPosition(previous, now, animateSnowplows) : [plow.longitude, plow.latitude] as PlowCoordinate
      plowMotionsRef.current.set(plow.id, { from, to: [plow.longitude, plow.latitude], startedAt: now })
      if (!plowAnnotationsRef.current.has(plow.id)) {
        const annotation = new mapkit.Annotation(
          { latitude: plow.latitude, longitude: plow.longitude },
          annotationElement('plow-marker', '🚛'),
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
        destination,
        annotationElement('destination-marker'),
        { title: destination.name, data: { kind: 'destination' } satisfies AnnotationData, enabled: false, accessibilityLabel: `目的地: ${destination.name}` },
      )
      map.addAnnotation(destinationAnnotationRef.current)
    } else {
      destinationAnnotationRef.current.coordinate = destination
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
      <small className="osm-attribution">道路データ © OpenStreetMap contributors</small>
    </div>
  )
}
