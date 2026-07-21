import { useEffect, useMemo, useRef } from 'react'
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { appConfig } from '../../api/config'
import type { Destination, RecommendedRoute, RoadCondition, RoadSegmentFeature, RoadSegmentFeatureCollection, Snowplow } from '../../api/contracts'

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
  animateSnowplows: boolean
}

function boundsOf(roads: RoadSegmentFeatureCollection): maplibregl.LngLatBounds {
  const bounds = new maplibregl.LngLatBounds()
  roads.features.forEach((feature) => {
    const lines = feature.geometry.type === 'LineString' ? [feature.geometry.coordinates] : feature.geometry.coordinates
    lines.forEach((line) => line.forEach((coordinate) => bounds.extend(coordinate as [number, number])))
  })
  return bounds
}

type PlowCoordinate = [number, number]
type PlowMotion = { from: PlowCoordinate; to: PlowCoordinate; startedAt: number }
const PLOW_INTERPOLATION_MS = 5_000

function motionPosition(motion: PlowMotion, now: number, animate: boolean): PlowCoordinate {
  if (!animate) return motion.to
  const linearProgress = Math.min(1, Math.max(0, (now - motion.startedAt) / PLOW_INTERPOLATION_MS))
  const progress = linearProgress * linearProgress * (3 - 2 * linearProgress)
  return [
    motion.from[0] + (motion.to[0] - motion.from[0]) * progress,
    motion.from[1] + (motion.to[1] - motion.from[1]) * progress,
  ]
}

function plowPointCollection(plows: Snowplow[], motions: Map<string, PlowMotion>, now: number, animate: boolean) {
  return {
    type: 'FeatureCollection' as const,
    features: plows.map((plow) => ({
      type: 'Feature' as const,
      properties: { id: plow.id, heading: plow.heading },
      geometry: { type: 'Point' as const, coordinates: motionPosition(motions.get(plow.id) ?? { from: [plow.longitude, plow.latitude], to: [plow.longitude, plow.latitude], startedAt: now }, now, animate) },
    })),
  }
}

export function YukisakiMap({ roads, conditions, snowplows, layers, destination, routes, activeRouteId, onRoadSelect, onPlowSelect, onMapDestination, animateSnowplows }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | undefined>(undefined)
  const selectedRoadRef = useRef<string | undefined>(undefined)
  const snowplowsRef = useRef(snowplows)
  const plowMotionsRef = useRef(new Map<string, PlowMotion>())
  const animateSnowplowsRef = useRef(animateSnowplows)
  snowplowsRef.current = snowplows
  animateSnowplowsRef.current = animateSnowplows
  const conditionsById = useMemo(() => new Map(conditions.map((item) => [item.segmentId, item])), [conditions])
  const enrichedRoads = useMemo(() => ({ ...roads, features: roads.features.map((feature) => ({ ...feature, properties: { ...feature.properties, ...(conditionsById.get(feature.properties.segment_id) ?? {}), selected: false } })) }), [roads, conditionsById])

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return
    const map = new maplibregl.Map({
      container: containerRef.current,
      style: { version: 8, sources: { osm: { type: 'raster', tiles: [appConfig.mapTileUrl], tileSize: 256, attribution: '© OpenStreetMap contributors' } }, layers: [{ id: 'osm', type: 'raster', source: 'osm', paint: { 'raster-saturation': -0.65, 'raster-opacity': .72 } }] },
      center: [appConfig.demo.position.longitude, appConfig.demo.position.latitude], zoom: 14.5, attributionControl: false,
    })
    map.addControl(new maplibregl.AttributionControl({ compact: true }), 'bottom-right')
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right')
    let animationFrame: number | undefined
    let lastPipePhase = -1
    map.on('load', () => {
      map.addSource('roads', { type: 'geojson', data: enrichedRoads, promoteId: 'segment_id' })
      map.addLayer({ id: 'snow-banks', type: 'line', source: 'roads', paint: { 'line-color': '#ffffff', 'line-opacity': .88, 'line-width': ['interpolate',['linear'],['zoom'],12,8,17,22], 'line-blur': 1.3 } })
      map.addLayer({ id: 'road-surface', type: 'line', source: 'roads', paint: { 'line-color': ['case',['boolean',['get','hasDrivabilityScore'],true],['interpolate',['linear'],['to-number',['get','drivabilityScore']],0,'#d73027',50,'#f6c945',75,'#6aaed6',100,'#176fc0'],'#9cabb8'], 'line-width': ['interpolate',['linear'],['zoom'],12,['case',['boolean',['feature-state','selected'],false],11,2.5],17,['case',['boolean',['feature-state','selected'],false],11,8]], 'line-opacity': .96 } })
      map.addLayer({ id: 'pipe-idle', type: 'line', source: 'roads', filter: ['==',['get','hasSnowmeltPipe'],true], paint: { 'line-color': '#00a8df', 'line-opacity': .96, 'line-width': ['interpolate',['linear'],['zoom'],12,2.5,17,5], 'line-offset': ['interpolate',['linear'],['zoom'],12,3,17,8], 'line-dasharray': [2,1.25] } })
      map.addLayer({ id: 'pipe-water', type: 'line', source: 'roads', filter: ['==',['get','snowmeltPipeOperating'],true], paint: { 'line-color': '#d9f8ff', 'line-opacity': 1, 'line-width': ['interpolate',['linear'],['zoom'],12,1.5,17,3], 'line-offset': ['interpolate',['linear'],['zoom'],12,3,17,8], 'line-dasharray': [1,1.3] } })
      map.addLayer({ id: 'tire-tracks', type: 'line', source: 'roads', filter: ['in',['get','status'],['literal',['recently_plowed','plowed']]], paint: { 'line-color': '#142839', 'line-opacity': .22, 'line-width': .8, 'line-gap-width': 2 } })
      map.addLayer({ id: 'slope-warning', type: 'line', source: 'roads', filter: ['>=',['to-number',['get','slopePercent']],7], paint: { 'line-color': '#dc4838', 'line-width': 3, 'line-dasharray': [1,1] } })
      map.addSource('plow-tracks', { type: 'geojson', data: { type: 'FeatureCollection', features: snowplows.filter((plow) => plow.track).map((plow) => ({ type: 'Feature', properties: { id: plow.id }, geometry: plow.track! })) } })
      map.addLayer({ id: 'plow-tracks', type: 'line', source: 'plow-tracks', paint: { 'line-color': '#344a5e', 'line-width': 5, 'line-opacity': .8 } })
      map.addSource('plows', { type: 'geojson', data: plowPointCollection(snowplowsRef.current, plowMotionsRef.current, performance.now(), false) })
      map.addLayer({ id: 'plows-halo', type: 'circle', source: 'plows', paint: { 'circle-radius': 16, 'circle-color': '#fff', 'circle-stroke-color': '#f59e0b', 'circle-stroke-width': 3 } })
      map.addLayer({ id: 'plows', type: 'symbol', source: 'plows', layout: { 'text-field': '🚛', 'text-size': 21, 'text-allow-overlap': true, 'text-rotate': ['get','heading'] } })
      map.addSource('current-location', { type: 'geojson', data: { type: 'Point', coordinates: [appConfig.demo.position.longitude, appConfig.demo.position.latitude] } })
      map.addLayer({ id: 'current-location-halo', type: 'circle', source: 'current-location', paint: { 'circle-radius': 13, 'circle-color': '#4c9fe8', 'circle-opacity': .22 } })
      map.addLayer({ id: 'current-location', type: 'circle', source: 'current-location', paint: { 'circle-radius': 6, 'circle-color': '#176fc0', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } })
      map.fitBounds(boundsOf(roads), { padding: 42, duration: 0 })
      map.on('click', 'road-surface', (event) => {
        const feature = event.features?.[0]
        if (!feature?.properties) return
        const id = feature.properties.segment_id as string
        if (selectedRoadRef.current) map.setFeatureState({ source: 'roads', id: selectedRoadRef.current }, { selected: false })
        map.setFeatureState({ source: 'roads', id }, { selected: true })
        selectedRoadRef.current = id
        const original = roads.features.find((item) => item.properties.segment_id === id)
        if (original) onRoadSelect(original)
      })
      map.on('click', 'plows', (event) => { const id = event.features?.[0]?.properties?.id as string | undefined; const plow = snowplowsRef.current.find((item) => item.id === id); if (plow) onPlowSelect(plow) })
      ;['road-surface','plows'].forEach((layer) => { map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' }); map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = '' }) })
      map.on('contextmenu', (event) => onMapDestination({ id: 'map-point', name: '地図で指定した地点', address: 'デモ道路内の指定地点', latitude: event.lngLat.lat, longitude: event.lngLat.lng }))
      navigator.geolocation?.getCurrentPosition((position) => {
        const candidate: [number,number] = [position.coords.longitude, position.coords.latitude]
        if (boundsOf(roads).contains(candidate)) (map.getSource('current-location') as GeoJSONSource).setData({ type: 'Point', coordinates: candidate })
      }, () => undefined, { timeout: 5_000, maximumAge: 60_000 })
      const renderMotion = (now: number) => {
        const motionEnabled = animateSnowplowsRef.current && !window.matchMedia('(prefers-reduced-motion: reduce)').matches
        ;(map.getSource('plows') as GeoJSONSource).setData(plowPointCollection(snowplowsRef.current, plowMotionsRef.current, now, motionEnabled))
        const pipePhase = Math.floor(now / 500) % 2
        if (pipePhase !== lastPipePhase) {
          lastPipePhase = pipePhase
          map.setPaintProperty('pipe-water', 'line-dasharray', pipePhase === 0 ? [1,1.3] : [1.3,1])
        }
        animationFrame = window.requestAnimationFrame(renderMotion)
      }
      animationFrame = window.requestAnimationFrame(renderMotion)
    })
    mapRef.current = map
    return () => { if (animationFrame) window.cancelAnimationFrame(animationFrame); map.remove(); mapRef.current = undefined }
  }, [])

  useEffect(() => { const source = mapRef.current?.getSource('roads') as GeoJSONSource | undefined; source?.setData(enrichedRoads) }, [enrichedRoads])
  useEffect(() => {
    const now = performance.now()
    const activeIds = new Set(snowplows.map((plow) => plow.id))
    snowplows.forEach((plow) => {
      const previous = plowMotionsRef.current.get(plow.id)
      const from = previous
        ? motionPosition(previous, now, animateSnowplowsRef.current)
        : [plow.longitude, plow.latitude] as PlowCoordinate
      plowMotionsRef.current.set(plow.id, {
        from,
        to: [plow.longitude, plow.latitude],
        startedAt: now,
      })
    })
    plowMotionsRef.current.forEach((_motion, id) => { if (!activeIds.has(id)) plowMotionsRef.current.delete(id) })

    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    const trackSource = map.getSource('plow-tracks') as GeoJSONSource | undefined
    trackSource?.setData({ type: 'FeatureCollection', features: snowplows.filter((plow) => plow.track).map((plow) => ({ type: 'Feature', properties: { id: plow.id }, geometry: plow.track! })) })
  }, [snowplows])
  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    const visibility = (id: string, shown: boolean) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', shown ? 'visible' : 'none') }
    visibility('road-surface', layers.drivability); visibility('snow-banks', layers.snowEffects)
    visibility('pipe-idle', layers.snowmelt); visibility('pipe-water', layers.snowmelt); visibility('tire-tracks', layers.plowing)
    visibility('plows', layers.plows); visibility('plows-halo', layers.plows); visibility('plow-tracks', layers.tracks)
    visibility('slope-warning', layers.slopes)
  }, [layers])

  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    const collection = { type: 'FeatureCollection' as const, features: (routes ?? []).map((route) => ({ type: 'Feature' as const, properties: { id: route.id, active: route.id === activeRouteId }, geometry: route.geometry })) }
    const source = map.getSource('routes') as GeoJSONSource | undefined
    if (source) source.setData(collection)
    else {
      map.addSource('routes', { type: 'geojson', data: collection })
      map.addLayer({ id: 'routes', type: 'line', source: 'routes', paint: { 'line-color': ['match',['get','id'],'fastest','#ef6a3a','recommended','#236cc4','#168755','#236cc4'], 'line-width': ['case',['==',['get','active'],true],8,3], 'line-opacity': ['case',['==',['get','active'],true],.95,.28] } })
    }
  }, [routes, activeRouteId])

  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    const data = { type: 'Feature' as const, properties: {}, geometry: { type: 'Point' as const, coordinates: destination ? [destination.longitude,destination.latitude] : [0,0] } }
    const source = map.getSource('destination') as GeoJSONSource | undefined
    if (source) source.setData(data)
    else { map.addSource('destination', { type: 'geojson', data }); map.addLayer({ id: 'destination', type: 'circle', source: 'destination', paint: { 'circle-radius': 8, 'circle-color': '#cf3c31', 'circle-stroke-color': '#fff', 'circle-stroke-width': 3 } }) }
  }, [destination])

  return <div ref={containerRef} className="map-canvas" aria-label="長岡市石動南町の道路状態地図" />
}
