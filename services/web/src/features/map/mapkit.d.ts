declare namespace mapkit {
  type CoordinateData = { latitude: number; longitude: number }
  type AnnotationFactory = (coordinate: Coordinate, options: AnnotationOptions) => HTMLElement
  type AnnotationOptions = {
    title?: string
    subtitle?: string
    data?: unknown
    enabled?: boolean
    visible?: boolean
    accessibilityLabel?: string
  }
  type OverlayOptions = {
    style?: Style
    data?: unknown
    enabled?: boolean
    visible?: boolean
  }

  class Coordinate {
    constructor(latitude: number, longitude: number)
    latitude: number
    longitude: number
  }
  class CoordinateSpan {
    constructor(latitudeDelta: number, longitudeDelta: number)
    latitudeDelta: number
    longitudeDelta: number
  }
  class CoordinateRegion {
    constructor(center: CoordinateData, span: CoordinateSpan)
    center: Coordinate
    span: CoordinateSpan
  }
  class Style {
    constructor(options?: {
      strokeColor?: string
      strokeOpacity?: number
      lineWidth?: number
      lineCap?: 'butt' | 'round' | 'square'
      lineJoin?: 'miter' | 'round' | 'bevel'
      lineDash?: number[]
      lineDashOffset?: number
    })
    strokeColor: string
    strokeOpacity: number
    lineWidth: number
    lineDash: number[]
    lineDashOffset: number
  }
  class Overlay {
    data: unknown
    enabled: boolean
    visible: boolean
    selected: boolean
    style: Style
  }
  class PolylineOverlay extends Overlay {
    constructor(points: Coordinate[], options?: OverlayOptions)
  }
  class Annotation extends EventTarget {
    constructor(location: Coordinate, factory: AnnotationFactory, options?: AnnotationOptions)
    coordinate: Coordinate
    data: unknown
    enabled: boolean
    visible: boolean
    selected: boolean
  }
  type MapOptions = {
    center?: CoordinateData
    region?: CoordinateRegion
    tintColor?: string
    showsMapTypeControl?: boolean
    isRotationEnabled?: boolean
    showsZoomControl?: boolean
    showsPointsOfInterest?: boolean
  }
  class Map extends EventTarget {
    constructor(parent: string | HTMLElement, options?: MapOptions)
    region: CoordinateRegion
    overlays: Overlay[]
    annotations: Annotation[]
    addOverlay(overlay: Overlay): Overlay | null
    addOverlays(overlays: Overlay[]): Overlay[]
    removeOverlay(overlay: Overlay): Overlay | null
    removeOverlays(overlays: Overlay[]): Overlay[]
    addAnnotation(annotation: Annotation): Annotation | null
    addAnnotations(annotations: Annotation[]): Annotation[]
    removeAnnotation(annotation: Annotation): Annotation | null
    removeAnnotations(annotations: Annotation[]): Annotation[]
    convertPointOnPageToCoordinate(point: DOMPoint): Coordinate
    destroy(): void
  }
  const loadedLibraries: string[]
}

declare const mapkit: {
  Coordinate: typeof mapkit.Coordinate
  CoordinateSpan: typeof mapkit.CoordinateSpan
  CoordinateRegion: typeof mapkit.CoordinateRegion
  Style: typeof mapkit.Style
  PolylineOverlay: typeof mapkit.PolylineOverlay
  Annotation: typeof mapkit.Annotation
  Map: typeof mapkit.Map
  loadedLibraries: string[]
}

interface Window {
  mapkit?: typeof mapkit
  __yukisakiMapKitReady?: () => void
}
