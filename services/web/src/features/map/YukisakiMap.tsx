import { useEffect, useMemo, useRef } from 'react'
import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { appConfig } from '../../api/config'
import type { Destination, RecommendedRoute, RoadCondition, RoadSegmentFeature, RoadSegmentFeatureCollection, Snowplow } from '../../api/contracts'

export type LayerVisibility = { drivability: boolean; snowmelt: boolean; plowing: boolean; plows: boolean; tracks: boolean; slopes: boolean; narrow: boolean; snowEffects: boolean }
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
}

function boundsOf(roads: RoadSegmentFeatureCollection): maplibregl.LngLatBounds {
  const bounds = new maplibregl.LngLatBounds()
  roads.features.forEach((feature) => feature.geometry.coordinates.forEach((coordinate) => bounds.extend(coordinate as [number, number])))
  return bounds
}

function plowFeatures(plows: Snowplow[], progress: number) {
  return plows.map((plow) => {
    const points = plow.track.coordinates
    const from = points[0] ?? [plow.longitude, plow.latitude]
    const to = points[points.length - 1] ?? from
    return { type: 'Feature' as const, properties: { id: plow.id, heading: plow.heading }, geometry: { type: 'Point' as const, coordinates: [from[0] + (to[0] - from[0]) * progress, from[1] + (to[1] - from[1]) * progress] } }
  })
}

export function YukisakiMap({ roads, conditions, snowplows, layers, destination, routes, activeRouteId, onRoadSelect, onPlowSelect, onMapDestination }: Props) {
  const containerRef = useRef<HTMLDivElement>(null)
  const mapRef = useRef<MapLibreMap | undefined>(undefined)
  const selectedRoadRef = useRef<string | undefined>(undefined)
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
    let animationTimer: number | undefined
    map.on('load', () => {
      map.addSource('roads', { type: 'geojson', data: enrichedRoads, promoteId: 'segment_id' })
      map.addLayer({ id: 'snow-banks', type: 'line', source: 'roads', paint: { 'line-color': '#ffffff', 'line-opacity': .88, 'line-width': ['interpolate',['linear'],['zoom'],12,8,17,22], 'line-blur': 1.3 } })
      map.addLayer({ id: 'road-surface', type: 'line', source: 'roads', paint: { 'line-color': ['match',['get','status'],'snowmelt','#44a9df','recently_plowed','#3f5368','plowed','#64788c','stale_plow_data','#aabcca','no_plow_record','#d8e7f1','warning','#e37a38','#879db2'], 'line-width': ['case',['boolean',['feature-state','selected'],false],11,['interpolate',['linear'],['zoom'],12,2.5,17,8]], 'line-opacity': .96 } })
      map.addLayer({ id: 'stale-snow', type: 'line', source: 'roads', filter: ['in',['get','status'],['literal',['stale_plow_data','no_plow_record']]], paint: { 'line-color': '#f8fcff', 'line-opacity': .52, 'line-width': ['interpolate',['linear'],['zoom'],12,2,17,6], 'line-dasharray': [1,1.6] } })
      map.addLayer({ id: 'pipe-idle', type: 'line', source: 'roads', filter: ['all',['==',['get','hasSnowmeltPipe'],true],['==',['get','snowmeltPipeOperating'],false]], paint: { 'line-color': '#8ccdf0', 'line-width': 3, 'line-dasharray': [2,2] } })
      map.addLayer({ id: 'pipe-water', type: 'line', source: 'roads', filter: ['==',['get','snowmeltPipeOperating'],true], paint: { 'line-color': '#b9efff', 'line-width': 2.5, 'line-dasharray': [1.2,1.6] } })
      map.addLayer({ id: 'tire-tracks', type: 'line', source: 'roads', filter: ['in',['get','status'],['literal',['recently_plowed','plowed']]], paint: { 'line-color': '#142839', 'line-opacity': .45, 'line-width': 1.2, 'line-gap-width': 2 } })
      map.addLayer({ id: 'narrow-warning', type: 'line', source: 'roads', filter: ['<',['to-number',['get','roadWidthM']],4.2], paint: { 'line-color': '#f38a3b', 'line-width': 2.5, 'line-dasharray': [2,1.5] } })
      map.addLayer({ id: 'slope-warning', type: 'line', source: 'roads', filter: ['>=',['to-number',['get','slopePercent']],7], paint: { 'line-color': '#dc4838', 'line-width': 3, 'line-dasharray': [1,1] } })
      map.addSource('plow-tracks', { type: 'geojson', data: { type: 'FeatureCollection', features: snowplows.map((plow) => ({ type: 'Feature', properties: { id: plow.id }, geometry: plow.track })) } })
      map.addLayer({ id: 'plow-tracks', type: 'line', source: 'plow-tracks', paint: { 'line-color': '#344a5e', 'line-width': 5, 'line-opacity': .8 } })
      map.addSource('plows', { type: 'geojson', data: { type: 'FeatureCollection', features: snowplows.map((plow) => ({ type: 'Feature', properties: { id: plow.id, heading: plow.heading }, geometry: { type: 'Point', coordinates: [plow.longitude, plow.latitude] } })) } })
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
      map.on('click', 'plows', (event) => { const id = event.features?.[0]?.properties?.id as string | undefined; const plow = snowplows.find((item) => item.id === id); if (plow) onPlowSelect(plow) })
      ;['road-surface','plows'].forEach((layer) => { map.on('mouseenter', layer, () => { map.getCanvas().style.cursor = 'pointer' }); map.on('mouseleave', layer, () => { map.getCanvas().style.cursor = '' }) })
      map.on('contextmenu', (event) => onMapDestination({ id: 'map-point', name: '地図で指定した地点', address: 'デモ道路内の指定地点', latitude: event.lngLat.lat, longitude: event.lngLat.lng }))
      navigator.geolocation?.getCurrentPosition((position) => {
        const candidate: [number,number] = [position.coords.longitude, position.coords.latitude]
        if (boundsOf(roads).contains(candidate)) (map.getSource('current-location') as GeoJSONSource).setData({ type: 'Point', coordinates: candidate })
      }, () => undefined, { timeout: 5_000, maximumAge: 60_000 })
      if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        let tick = 0
        animationTimer = window.setInterval(() => {
          tick = (tick + 1) % 100
          ;(map.getSource('plows') as GeoJSONSource).setData({ type: 'FeatureCollection', features: plowFeatures(snowplows, tick / 100) })
          map.setPaintProperty('pipe-water', 'line-dasharray', tick % 2 === 0 ? [1.2,1.6] : [1.6,1.2])
        }, 240)
      }
    })
    mapRef.current = map
    return () => { if (animationTimer) window.clearInterval(animationTimer); map.remove(); mapRef.current = undefined }
  }, [])

  useEffect(() => { const source = mapRef.current?.getSource('roads') as GeoJSONSource | undefined; source?.setData(enrichedRoads) }, [enrichedRoads])
  useEffect(() => {
    const map = mapRef.current
    if (!map?.isStyleLoaded()) return
    const visibility = (id: string, shown: boolean) => { if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', shown ? 'visible' : 'none') }
    visibility('road-surface', layers.drivability); visibility('snow-banks', layers.snowEffects); visibility('stale-snow', layers.snowEffects)
    visibility('pipe-idle', layers.snowmelt); visibility('pipe-water', layers.snowmelt); visibility('tire-tracks', layers.plowing)
    visibility('plows', layers.plows); visibility('plows-halo', layers.plows); visibility('plow-tracks', layers.tracks)
    visibility('slope-warning', layers.slopes); visibility('narrow-warning', layers.narrow)
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
