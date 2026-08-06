import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import { appConfig } from './api/config'
import { yukisakiApi } from './api/createYukisakiApi'
import type {
  ApiDepartureRecommendation,
  ApiRouteResponse,
  DangerExplanation,
  Destination,
  DestinationSuggestion,
  Position,
  RecommendedRoute,
  RoadCondition,
  RoadSegmentFeature,
  RouteExplanation,
  Snowplow,
} from './api/contracts'
import { YukisakiMap, type HazardPoint, type LayerVisibility } from './features/map/YukisakiMap'
import { useYukisakiData } from './hooks/useYukisakiData'

type Screen = 'splash' | 'home' | 'routes' | 'navigation'
type Sheet = 'layers' | 'road' | 'plow' | 'hazard' | undefined
// Keep the first paint intentionally light. Supplemental overlays remain
// available from the layer sheet and are created only when selected.
const defaultLayers: LayerVisibility = {
  drivability: true,
  snowmelt: true,
  plowing: false,
  plows: true,
  tracks: false,
  slopes: false,
  snowEffects: false,
}

class CurrentLocationError extends Error {}

// Demo current location: every visitor is placed at Nagaoka University of
// Technology instead of reading the browser's real geolocation, so the
// route search origin is consistent regardless of where the device
// actually is. Coordinates confirmed via the app's own Apple Maps place
// search (GET /v1/places/search?q=長岡技術科学大学).
const DEMO_CURRENT_POSITION: Position = { latitude: 37.4252099, longitude: 138.7782025 }

function readCurrentLocation(): Promise<Position> {
  return Promise.resolve(DEMO_CURRENT_POSITION)
}

function isInsideDemoArea(position: Position) {
  const bounds = appConfig.demo.bounds
  return position.longitude >= bounds.minLongitude
    && position.longitude <= bounds.maxLongitude
    && position.latitude >= bounds.minLatitude
    && position.latitude <= bounds.maxLatitude
}

class ApplicationErrorBoundary extends Component<{ children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, details: ErrorInfo) {
    console.error('Yukisaki rendering failed', error, details.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return <div className="loading" role="alert">
      <b>地図の表示中にエラーが発生しました</b>
      <small>{this.state.error.message}</small>
      <button className="primary" onClick={() => window.location.reload()}>再読み込み</button>
    </div>
  }
}

function SnowplowArt({ compact = false }: { compact?: boolean }) {
  return <svg className={compact ? 'plow-art compact' : 'plow-art'} viewBox="0 0 220 120" role="img" aria-label="右へ進む除雪車">
    <defs>
      <linearGradient id="plow-body" x1="0" x2="1"><stop stopColor="#ffcb3d"/><stop offset="1" stopColor="#f39119"/></linearGradient>
      <linearGradient id="plow-blade" x1="0" y1="0" x2="1" y2="1"><stop stopColor="#eff8fd"/><stop offset="1" stopColor="#a9c5d8"/></linearGradient>
    </defs>
    <path d="M43 47h84v50H35V58a11 11 0 0 1 8-11Z" fill="url(#plow-body)"/>
    <path d="M119 28h39c18 0 28 13 28 31v38h-67Z" fill="#f49b1b"/>
    <path d="M129 37h27c10 0 17 8 18 20h-45Z" fill="#c6ebff" stroke="#fff" strokeWidth="3"/>
    <path d="M156 37v20" stroke="#7fb3d2" strokeWidth="3"/>
    <rect x="49" y="59" width="45" height="10" rx="5" fill="#ffdf75"/>
    <path d="M180 61 211 46l4 53-35-8Z" fill="url(#plow-blade)" stroke="#7898ad" strokeWidth="4"/>
    <path d="m184 70 25-11M184 82l27-10" stroke="#fff" strokeWidth="3" opacity=".8"/>
    <path d="M177 78h10" stroke="#45596a" strokeWidth="5"/>
    <rect x="59" y="33" width="10" height="16" rx="3" fill="#334659"/>
    <rect x="142" y="18" width="17" height="10" rx="5" fill="#ff5d4e"/>
    <rect x="183" y="64" width="6" height="12" rx="2" fill="#fff4a7"/>
    <g className="plow-wheel rear-wheel"><circle cx="66" cy="96" r="18" fill="#17202d"/><circle cx="66" cy="96" r="8" fill="#718295"/><path d="M66 82v28M52 96h28" stroke="#a9b7c4" strokeWidth="3"/></g>
    <g className="plow-wheel front-wheel"><circle cx="151" cy="96" r="18" fill="#17202d"/><circle cx="151" cy="96" r="8" fill="#718295"/><path d="M151 82v28M137 96h28" stroke="#a9b7c4" strokeWidth="3"/></g>
    <path d="M31 84h151" stroke="#d37b10" strokeWidth="5"/>
  </svg>
}

// The plow loops (CSS animation-iteration-count: infinite) rather than
// playing once, so "animationiteration" — which fires exactly when a cycle
// wraps back to its 0% frame, i.e. the plow off-screen at its leftmost — is
// used to reveal the map on a clean beat instead of an arbitrary timer tick.
// Three loops of the ~1.65s cycle land close to the requested ~5s splash.
const PLOW_LOOPS_BEFORE_EXIT = 3

function Splash({ onDone }: { onDone: () => void }) {
  const [exiting, setExiting] = useState(false)
  const onDoneRef = useRef(onDone)
  const skippedRef = useRef(false)
  const plowRef = useRef<HTMLDivElement>(null)

  useEffect(() => { onDoneRef.current = onDone }, [onDone])
  useEffect(() => {
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    if (reducedMotion) {
      const exitTimer = window.setTimeout(() => setExiting(true), 360)
      const doneTimer = window.setTimeout(() => onDoneRef.current(), 520)
      return () => {
        window.clearTimeout(exitTimer)
        window.clearTimeout(doneTimer)
      }
    }
    const plow = plowRef.current
    const finish = () => {
      setExiting(true)
      window.setTimeout(() => onDoneRef.current(), 200)
    }
    if (!plow) {
      const fallback = window.setTimeout(finish, 5_000)
      return () => window.clearTimeout(fallback)
    }
    let loops = 0
    const onLoop = () => {
      loops += 1
      if (loops < PLOW_LOOPS_BEFORE_EXIT) return
      plow.removeEventListener('animationiteration', onLoop)
      finish()
    }
    plow.addEventListener('animationiteration', onLoop)
    // Safety net in case the animation never fires (e.g. animations disabled by the browser).
    const fallback = window.setTimeout(finish, 7_000)
    return () => {
      plow.removeEventListener('animationiteration', onLoop)
      window.clearTimeout(fallback)
    }
  }, [])

  const skip = () => {
    if (skippedRef.current) return
    skippedRef.current = true
    setExiting(true)
    window.setTimeout(() => onDoneRef.current(), 160)
  }

  return <button className={`splash${exiting ? ' is-exiting' : ''}`} onClick={skip} aria-label="ホーム画面へ進む">
    <div className="splash-top">
      <div className="splash-brand">
        <img src="/brand/yukisaki-logo.png" alt="Yukisaki"/>
        <p>雪の先に、走りやすい道を。</p>
      </div>
      <div className="splash-status"><span/><b>長岡の道路情報を準備しています</b></div>
    </div>
    <div className="snow-clearing-animation" aria-hidden="true">
      <svg className="clearing-scene" viewBox="0 0 1000 220" preserveAspectRatio="none">
        <defs>
          <linearGradient id="opening-road" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#526579"/>
            <stop offset=".55" stopColor="#34475a"/>
            <stop offset="1" stopColor="#2a3b4d"/>
          </linearGradient>
          <linearGradient id="opening-snow" x1="0" y1="0" x2="0" y2="1">
            <stop stopColor="#ffffff"/>
            <stop offset="1" stopColor="#dcebf3"/>
          </linearGradient>
          <mask id="opening-snow-mask">
            <rect width="1000" height="220" fill="white"/>
            <rect className="snow-clear-mask" x="0" y="65" width="1000" height="94" rx="24" fill="black"/>
          </mask>
        </defs>
        <rect x="0" y="43" width="1000" height="142" fill="url(#opening-road)"/>
        <path d="M0 58H1000M0 170H1000" stroke="#9cafbf" strokeWidth="4" opacity=".5"/>
        <path d="M0 113H1000" stroke="#f2dda0" strokeWidth="5" strokeDasharray="62 42" opacity=".9"/>
        <path className="snow-cover" d="M0 35Q75 24 150 39T300 36T450 40T600 34T750 39T900 35T1000 38V187Q925 197 850 184T700 189T550 184T400 190T250 185T100 191T0 187Z" fill="url(#opening-snow)" mask="url(#opening-snow-mask)"/>
        <path d="M0 60Q80 51 160 62T320 59T480 63T640 58T800 62T1000 59M0 166Q85 174 170 164T340 169T510 164T680 170T850 165T1000 168" fill="none" stroke="#f9fcfe" strokeWidth="13" strokeLinecap="round"/>
      </svg>
      <div className="moving-plow" ref={plowRef}>
        <SnowplowArt/>
        <svg className="plow-snow-ridge" viewBox="0 0 72 46">
          <path d="M1 43c7-18 16-11 22-25 5 9 12 6 16 17 7-10 18-5 31 8Z" fill="#f7fbfd" stroke="#c8dce8" strokeWidth="2"/>
        </svg>
      </div>
    </div>
    <small>タップしてスキップ</small>
  </button>
}

function BottomSheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }; window.addEventListener('keydown', close); return () => window.removeEventListener('keydown', close) }, [onClose])
  return <div className="sheet-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><section className="bottom-sheet" role="dialog" aria-modal="true" aria-label={title}>
    <div className="sheet-handle"/><header><h2>{title}</h2><button className="icon-button" onClick={onClose} aria-label={`${title}を閉じる`}>×</button></header>{children}
  </section></div>
}

function Score({ value }: { value: number }) { return <span className={`score ${value >= 80 ? 'good' : value >= 60 ? 'fair' : 'care'}`}><b>{value}</b><small>/100</small></span> }

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return '情報なし'
  if (typeof value === 'boolean') return value ? 'はい' : 'いいえ'
  if (Array.isArray(value)) return value.map(displayValue).join('、')
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .map(([key, item]) => `${key}: ${displayValue(item)}`)
      .join(' / ')
  }
  return String(value)
}

const scoreLabels: Record<string, string> = {
  snow_pipe: '消雪パイプ',
  temperature_c: '気温',
  last_plowed_at: '最終除雪車通過',
  snowfall_1h_cm: '1時間降雪量',
  max_slope_percent: '最大勾配',
  road_type: '道路種別',
  no_plow_history: '除雪実績なし',
  active_snow_pipe: '消雪パイプ作動中',
  light_hourly_snowfall: '弱い降雪',
  moderate_hourly_snowfall: '中程度の降雪',
  heavy_hourly_snowfall: '強い降雪',
  freezing_wet_condition: '凍結しやすい路面・気温',
  narrow_road: '狭い生活道路',
  steep_slope: '急な坂道',
  moderate_slope: 'やや急な坂道',
  plowed_within_60_minutes: '60分以内に除雪車が通過',
  plowed_60_to_180_minutes_ago: '除雪から60〜180分経過',
  plowed_over_180_minutes_ago: '除雪から180分以上経過',
  bridge: '橋梁区間',
}

const highwayLabels: Record<string, string> = {
  motorway: '高速道路',
  motorway_link: '高速道路ランプ',
  trunk: '国道',
  trunk_link: '国道ランプ',
  primary: '主要道路',
  primary_link: '主要道路ランプ',
  secondary: '幹線道路',
  secondary_link: '幹線道路ランプ',
  tertiary: '地方道',
  tertiary_link: '地方道ランプ',
  unclassified: 'その他の道路',
  residential: '生活道路',
  living_street: '歩車共存道路',
  service: '構内・私道',
  track: '未舗装路',
}

function translateHighway(value: unknown): string {
  if (typeof value !== 'string') return displayValue(value)
  return highwayLabels[value] ?? value
}

function scoreValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '情報なし'
  if (key === 'temperature_c') return `${value} ℃`
  if (key === 'snowfall_1h_cm') return `${value} cm`
  if (key === 'max_slope_percent') return `${value} %`
  if (key === 'road_type') return translateHighway(value)
  if (key === 'last_plowed_at' && typeof value === 'string') {
    const date = new Date(value)
    return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })
  }
  return displayValue(value)
}

type ScoreSection = { title: string; rows: Array<{ key: string; label: string; value: unknown }> }

function scoreSections(condition: RoadCondition | undefined): ScoreSection[] {
  const raw = condition?.scoreFactors as unknown
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const factors = raw as Record<string, unknown>
    const inputs = factors.inputs
    const appliedRules = factors.applied_rules
    const sourceRunIds = factors.source_run_ids
    const sections: ScoreSection[] = []
    if (inputs && typeof inputs === 'object' && !Array.isArray(inputs)) {
      sections.push({
        title: '算出に使用したデータ',
        rows: Object.entries(inputs as Record<string, unknown>).map(([key, value]) => ({
          key, label: scoreLabels[key] ?? key, value,
        })),
      })
    }
    if (appliedRules && typeof appliedRules === 'object' && !Array.isArray(appliedRules)) {
      sections.push({
        title: '適用された補正',
        rows: Object.entries(appliedRules as Record<string, unknown>).map(([key, value]) => ({
          key, label: scoreLabels[key] ?? key, value,
        })),
      })
    }
    if (Array.isArray(sourceRunIds)) {
      sections.push({
        title: '算出データID',
        rows: sourceRunIds.map((value, index) => ({
          key: `source-${index}`, label: `データ ${index + 1}`, value,
        })),
      })
    }
    if (sections.length) return sections
  }

  if (condition?.scoreFactorDetails?.length) {
    return [{
      title: '適用された根拠',
      rows: condition.scoreFactorDetails.map((factor, index) => ({
        key: `factor-${index}`, label: factor.label, value: factor.value,
      })),
    }]
  }

  const breakdown = condition?.scoreBreakdown
  return breakdown ? [{
    title: 'スコア内訳',
    rows: [
      ['base', '基本点', breakdown.base],
      ['snowmeltPipe', '消雪パイプ', breakdown.snowmeltPipe],
      ['snowmeltPipeOperation', '稼働状態', breakdown.snowmeltPipeOperation],
      ['recentPlowing', '除雪実績', breakdown.recentPlowing],
      ['roadClass', '道路種別', breakdown.roadClass],
      ['roadWidth', '道幅', breakdown.roadWidth],
      ['slope', '坂道', breakdown.slope],
      ['dataFreshness', '情報の新しさ', breakdown.dataFreshness],
    ].map(([key, label, value]) => ({ key: String(key), label: String(label), value })),
  }] : []
}

function LayerSheet({ layers, setLayers, close }: { layers: LayerVisibility; setLayers: (layers: LayerVisibility) => void; close: () => void }) {
  const items: [keyof LayerVisibility,string,string][] = [['drivability','走りやすさ指数','道路ごとの指数を色分け'],['snowmelt','消雪パイプ','道路脇の水色ライン'],['plows','除雪車の現在地','5秒かけて次の位置へ移動'],['tracks','除雪車の走行軌跡','走行済みの道路'],['snowEffects','雪のビジュアル演出','実測積雪量ではありません']]
  return <BottomSheet title="地図レイヤー" onClose={close}><div className="sheet-content layer-list">{items.map(([key,label,note]) => <label key={key}><span><b>{label}</b><small>{note}</small></span><input type="checkbox" checked={layers[key]} onChange={() => setLayers({ ...layers, [key]: !layers[key] })}/><i/></label>)}</div></BottomSheet>
}

function RoadSheet({ road, condition, loading, error, close }: { road: RoadSegmentFeature; condition: ReturnType<typeof useYukisakiData>['conditions'][number] | undefined; loading: boolean; error?: string; close: () => void }) {
  const p = road.properties
  const sections = scoreSections(condition)
  return <BottomSheet title="道路区間の詳細" onClose={close}><div className="sheet-content">
    <div className="road-title"><div><small>{p.highway ? translateHighway(p.highway) : '道路'}</small><h3>{p.road_name || p.name || '名称のない道路'}</h3><code>{p.segment_id}</code></div>{condition && <Score value={condition.drivabilityScore}/>}</div>
    {loading && <div className="detail-loading" role="status"><div className="spinner"/>道路の詳細情報を読み込んでいます</div>}
    {error && <div className="detail-error" role="alert"><b>詳細を取得できませんでした</b><span>{error}</span></div>}
    {!loading && condition && <><div className="fact-grid"><span>道幅<b>{condition.roadWidthM ? `${condition.roadWidthM} m` : '情報なし'}</b></span><span>一方通行<b>{p.oneway === true || p.oneway === 'yes' ? 'はい' : 'いいえ'}</b></span><span>消雪パイプ<b>{condition.hasSnowmeltPipe ? condition.snowmeltPipeOperating ? '作動中' : 'あり・停止中' : '設置情報なし'}</b></span><span>最終除雪車通過<b>{condition.lastPlowedAt ? new Date(condition.lastPlowedAt).toLocaleString('ja-JP',{ timeZone:'Asia/Tokyo' }) : '走行実績を確認できません'}</b></span></div>
    <h4>APIが返したスコアの根拠</h4>{sections.map((section) => <section className="score-section" key={section.title}><h5>{section.title}</h5><div className="breakdown">{section.rows.map(({ key, label, value }) => { const numeric = typeof value === 'number' ? value : null; return <div key={key}><span>{label}</span><b className={numeric !== null && numeric < 0 ? 'minus' : ''}>{numeric !== null && numeric > 0 ? '+' : ''}{scoreValue(key, value)}</b></div> })}</div></section>)}
    {[...condition.reasons,...condition.warnings].length > 0 && <div className="reason-list">{condition.reasons.map((reason) => <span key={reason}>✓ {reason}</span>)}{condition.warnings.map((warning) => <span className="warn" key={warning}>△ {warning}</span>)}</div>}
    <p className="data-note">更新: {condition.updatedAt ? new Date(condition.updatedAt).toLocaleString('ja-JP',{ timeZone:'Asia/Tokyo' }) : '時刻情報なし'}</p></>}
  </div></BottomSheet>
}

function PlowSheet({ plow, close }: { plow: Snowplow; close: () => void }) {
  return <BottomSheet title="除雪車の詳細" onClose={close}><div className="sheet-content"><div className="plow-heading"><div className="plow-icon"><SnowplowArt compact/></div><div><h3>{plow.name}</h3><span className="working-dot"/> {plow.status === 'working' ? '現在作業中' : plow.status === 'moving' ? '移動中' : '停止中'}</div></div>
    <div className="fact-grid"><span>速度<b>{plow.speedKmh} km/h</b></span><span>進行方向<b>{plow.heading}°</b></span><span>本日の除雪距離<b>{plow.todayDistanceKm === null ? 'API提供なし' : `${plow.todayDistanceKm} km`}</b></span><span>走行済み軌跡<b>{plow.track ? `${plow.track.coordinates.length} 地点` : 'API提供なし'}</b></span></div><div className="reason-list"><span>{plow.matchedSegmentId ? `✓ 道路 ${plow.matchedSegmentId} にマッチ` : '道路との紐付け情報なし'}</span><span>{plow.plannedRoute ? '→ 除雪予定ルートあり' : '予定ルート情報なし'}</span></div><p className="data-note">更新: {plow.lastUpdatedAt ? new Date(plow.lastUpdatedAt).toLocaleString('ja-JP',{ timeZone:'Asia/Tokyo' }) : '時刻情報なし'}</p>
  </div></BottomSheet>
}

function HazardSheet({ hazard, close }: { hazard: HazardPoint; close: () => void }) {
  return <BottomSheet title="注意箇所の詳細" onClose={close}><div className="sheet-content">
    <div className="road-title"><div><small>最低走りやすさ指数</small><h3>{hazard.minimumScore ?? '未算出'}</h3></div></div>
    {hazard.explanation ? <p>{hazard.explanation}</p> : <div className="detail-loading" role="status"><div className="spinner"/>AIによる説明を生成しています</div>}
    {hazard.cautions.length > 0 && <div className="reason-list">{hazard.cautions.map((caution) => <span className="warn" key={caution}>△ {caution}</span>)}</div>}
    <p className="data-note">判定要因: {hazard.factors.map((factor) => scoreLabels[factor] ?? factor).join('、') || '情報なし'}</p>
  </div></BottomSheet>
}

function Header({ weather }: { weather?: ReturnType<typeof useYukisakiData>['weather'] }) { return <header className="topbar"><div className="mini-logo"><img src="/brand/yukisaki-logo.png" alt="Yukisaki"/></div><div className="weather"><span>❄ {weather?.temperatureC ?? '--'}°</span><small>{weather?.condition ?? '読込中'}</small></div></header> }

function Search({ onChoose }: { onChoose: (destination: Destination) => void }) {
  const [query, setQuery] = useState('')
  const [suggestions, setSuggestions] = useState<DestinationSuggestion[]>([])
  const [candidates, setCandidates] = useState<Destination[]>([])
  const [open, setOpen] = useState(false)
  const [error, setError] = useState<string>()
  const [resolving, setResolving] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    let active = true
    if (query.trim().length < 2) {
      setSuggestions([])
      setCandidates([])
      setError(undefined)
      return () => controller.abort()
    }
    const timer = window.setTimeout(() => {
      yukisakiApi.autocompleteDestinations(query, controller.signal).then((value) => {
        if (!active) return
        setSuggestions(value)
        setCandidates([])
        setError(undefined)
      }).catch(() => {
        if (active) setError('地点候補を取得できませんでした。')
      })
    }, 300)
    return () => {
      window.clearTimeout(timer)
      active = false
      controller.abort()
    }
  }, [query])

  const resolve = (suggestion: DestinationSuggestion) => {
    setResolving(true)
    setError(undefined)
    yukisakiApi.getDestinations(suggestion.query).then((value) => {
      setCandidates(value)
      if (!value.length) setError('長岡市内の地点を特定できませんでした。')
    }).catch(() => setError('地点を検索できませんでした。')).finally(() => setResolving(false))
  }

  const choose = (item: Destination) => {
    onChoose(item)
    setQuery(item.name)
    setOpen(false)
  }

  return <div className="search-wrap">
    <label className="search"><span>⌕</span><input value={query} onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true) }} placeholder="目的地を検索" aria-label="目的地を検索"/></label>
    {open && query.trim().length >= 2 && <div className="search-results">
      {candidates.length > 0
        ? candidates.map((item) => <button key={item.id} onClick={() => choose(item)}><b>{item.name}</b><small>{item.address}</small></button>)
        : suggestions.map((item) => <button key={item.id} onClick={() => resolve(item)}><b>{item.name}</b><small>{item.address || '候補を選んで位置を確認'}</small></button>)}
      {resolving && <p>Apple Mapsで位置を確認しています…</p>}
      {error && <p className="inline-error">{error}</p>}
      <p>候補を選択してから経路を探索します</p>
    </div>}
  </div>
}

function AppContent() {
  const [screen, setScreen] = useState<Screen>('splash')
  const [sheet, setSheet] = useState<Sheet>()
  const [layers, setLayers] = useState(defaultLayers)
  const [road, setRoad] = useState<RoadSegmentFeature>()
  const [roadCondition, setRoadCondition] = useState<RoadCondition>()
  const [roadDetailLoading, setRoadDetailLoading] = useState(false)
  const [roadDetailError, setRoadDetailError] = useState<string>()
  const roadDetailRequestId = useRef(0)
  const [plow, setPlow] = useState<Snowplow>()
  const [activeHazardId, setActiveHazardId] = useState<string>()
  const [destination, setDestination] = useState<Destination>()
  const [routes, setRoutes] = useState<RecommendedRoute[]>([])
  const [activeRoute, setActiveRoute] = useState('')
  const [routeLoading, setRouteLoading] = useState(false)
  const [aiLoading, setAiLoading] = useState(false)
  const [routeResponse, setRouteResponse] = useState<ApiRouteResponse>()
  const [routeExplanation, setRouteExplanation] = useState<RouteExplanation>()
  const [dangerExplanation, setDangerExplanation] = useState<DangerExplanation>()
  const [routeError, setRouteError] = useState<string>()
  const [currentPosition, setCurrentPosition] = useState<Position>()
  const currentLocationRequest = useRef<Promise<Position> | undefined>(undefined)
  const data = useYukisakiData()
  const condition = roadCondition
  const scoredConditions = data.conditions.filter((item) => item.hasDrivabilityScore !== false)
  const averageScore = scoredConditions.length ? Math.round(scoredConditions.reduce((sum,item) => sum + item.drivabilityScore,0) / scoredConditions.length) : 0

  const activeApiRoute = routeResponse?.routes.find((route) => route.route_id === activeRoute)
  const hazardPoints = useMemo<HazardPoint[]>(() => {
    if (!activeApiRoute) return []
    return activeApiRoute.hazard_groups.map((group, index) => {
      const hazardId = `${activeApiRoute.route_id}-hazard-${index + 1}`
      const coordinates = group.geometry.coordinates
      const [longitude, latitude] = coordinates[Math.floor(coordinates.length / 2)] ?? coordinates[0] ?? [0, 0]
      const explanation = dangerExplanation?.hazards.find((item) => item.hazardId === hazardId)
      return {
        hazardId, latitude, longitude,
        minimumScore: group.minimum_drivability_score,
        factors: group.factors,
        explanation: explanation?.explanation,
        cautions: explanation?.cautions ?? [],
      }
    })
  }, [activeApiRoute, dangerExplanation])
  const activeHazard = hazardPoints.find((item) => item.hazardId === activeHazardId)

  const requestCurrentLocation = useCallback(() => {
    if (currentLocationRequest.current) return currentLocationRequest.current
    const request = readCurrentLocation()
      .then((position) => {
        setCurrentPosition(position)
        return position
      })
      .finally(() => {
        if (currentLocationRequest.current === request) currentLocationRequest.current = undefined
      })
    currentLocationRequest.current = request
    return request
  }, [])

  useEffect(() => {
    void requestCurrentLocation().catch(() => undefined)
  }, [requestCurrentLocation])

  const selectDestination = async (item: Destination) => {
    setDestination(item)
    if (!data.roads) return
    setRouteLoading(true)
    setRouteError(undefined)
    setRoutes([])
    setRouteResponse(undefined)
    setRouteExplanation(undefined)
    setDangerExplanation(undefined)
    try {
      const origin = await requestCurrentLocation()
      if (!isInsideDemoArea(origin)) {
        throw new CurrentLocationError('現在地が経路探索の対象範囲（長岡市）外です。現在は長岡市内からの経路だけを探索できます。')
      }
      const response = await yukisakiApi.recommendRoutes({
        origin,
        destination: item,
        preference: 'recommended',
        avoid: [],
        prefer: [],
      })
      const selectedId = response.routes[0]?.id ?? ''
      setRoutes(response.routes)
      setActiveRoute(selectedId)
      setRouteResponse(response.apiResponse)
      setScreen('routes')
      setRouteLoading(false)
      if (response.apiResponse) {
        setAiLoading(true)
        Promise.allSettled([
          yukisakiApi.explainRoutes(response.apiResponse),
          yukisakiApi.explainDangerPoints(response.apiResponse, selectedId),
        ]).then(([explanation, danger]) => {
          if (explanation.status === 'fulfilled') setRouteExplanation(explanation.value)
          if (danger.status === 'fulfilled') setDangerExplanation(danger.value)
        }).finally(() => setAiLoading(false))
      }
    } catch (error) {
      if (error instanceof CurrentLocationError) {
        setRouteError(error.message)
        setRouteLoading(false)
        return
      }
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined
      setRouteError(status === 409
        ? '経路探索用の道路グラフがまだロードされていません。'
        : '経路APIを利用できませんでした。環境の起動状態を確認してください。')
      setRouteLoading(false)
    }
  }

  const selectRoad = (item: RoadSegmentFeature) => {
    const requestId = ++roadDetailRequestId.current
    setRoad(item)
    setRoadCondition(undefined)
    setRoadDetailError(undefined)
    setRoadDetailLoading(true)
    setSheet('road')
    yukisakiApi.getRoadSegment(item.properties.segment_id).then((detail) => {
      if (requestId !== roadDetailRequestId.current) return
      setRoad(detail.road)
      setRoadCondition(detail.condition)
    }).catch(() => {
      if (requestId === roadDetailRequestId.current) {
        setRoadDetailError('最後に取得した地図データは維持しています。もう一度道路を選択してください。')
      }
    }).finally(() => {
      if (requestId === roadDetailRequestId.current) setRoadDetailLoading(false)
    })
  }

  const selectRoute = (id: string) => {
    setActiveRoute(id)
    if (routeResponse) {
      yukisakiApi.explainDangerPoints(routeResponse, id)
        .then(setDangerExplanation)
        .catch(() => setDangerExplanation(undefined))
    }
  }

  if (screen === 'splash') return <Splash onDone={() => setScreen('home')}/>
  if (data.error) return <div className="loading" role="alert"><b>{data.error}</b><button className="primary" onClick={data.retry}>再試行</button></div>
  if (data.loading || !data.roads) return <div className="loading" role="status" aria-live="polite"><div className="spinner"/><b>道路データを読み込んでいます</b><small>長岡市全域・デモデータ</small></div>
  return <div className="app-screen"><Header weather={data.weather}/>
    <DepartureToast/>
    <YukisakiMap roads={data.roads} conditions={data.conditions} snowplows={data.snowplows} layers={layers} currentPosition={currentPosition} destination={destination} routes={screen === 'routes' || screen === 'navigation' ? routes : undefined} activeRouteId={activeRoute} hazards={screen === 'routes' || screen === 'navigation' ? hazardPoints : undefined} onRoadSelect={selectRoad} onPlowSelect={(item) => { setPlow(item); setSheet('plow') }} onHazardSelect={(item) => { setActiveHazardId(item.hazardId); setSheet('hazard') }} onMapDestination={selectDestination} onViewportChange={data.refreshMap} animateSnowplows/>
    {layers.snowEffects && <div className="map-snow" aria-hidden="true"/>}
    {screen === 'home' && <><Search onChoose={selectDestination}/><div className="map-actions"><button onClick={() => setSheet('layers')} aria-label="地図レイヤーを選択">◇</button></div><div className="legend"><b>走りやすさ指数</b><span className="score-gradient"/><small><em>注意 0–59</em><em>60–74</em><em>75–84</em><em>良好 85–100</em></small><span className="legend-unknown"><i/>未算出</span></div>{routeError && <div className="api-warning route-error" role="alert"><b>経路探索エラー</b><span>{routeError}</span></div>}{data.updateStopped && <div className="api-warning" role="alert"><b>更新停止</b><span>最後に取得したデータを表示しています</span></div>}{data.viewportRefreshing && <div className="api-warning truncated" role="status"><b>表示範囲を更新中</b><span>道路データを再取得しています</span></div>}<section className="home-card"><div><small>現在地周辺の走りやすさ</small><h2>{appConfig.demo.area}</h2><p>走りやすさ指数・消雪パイプを道路上に表示</p></div><Score value={averageScore}/><footer><span>更新 {data.meta?.dataTimestamp ? new Date(data.meta.dataTimestamp).toLocaleString('ja-JP',{ timeZone:'Asia/Tokyo' }) : appConfig.demo.label}</span></footer></section></>}
    {screen === 'routes' && <RoutePanel routes={routes} active={activeRoute} setActive={selectRoute} explanation={routeExplanation} aiLoading={aiLoading} departureRecommendation={routeResponse?.departure_recommendation} back={() => setScreen('home')} start={() => setScreen('navigation')}/>}
    {screen === 'navigation' && <NavigationPanel route={routes.find((item) => item.id === activeRoute)} back={() => setScreen('home')}/>} 
    {routeLoading && <div className="route-loading" role="status"><div className="spinner"/>ルート候補を準備しています</div>}
    {sheet === 'layers' && <LayerSheet layers={layers} setLayers={setLayers} close={() => setSheet(undefined)}/>} {sheet === 'road' && road && <RoadSheet road={road} condition={condition} loading={roadDetailLoading} error={roadDetailError} close={() => setSheet(undefined)}/>} {sheet === 'plow' && plow && <PlowSheet plow={plow} close={() => setSheet(undefined)}/>} {sheet === 'hazard' && activeHazard && <HazardSheet hazard={activeHazard} close={() => setSheet(undefined)}/>}
  </div>
}

function departureTimeLabel(iso: string) {
  return new Date(iso).toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })
}

const DEPARTURE_TOAST_OFFSET_MINUTES = 28
const DEPARTURE_TOAST_INTERVAL_MS = 60_000
const DEPARTURE_TOAST_VISIBLE_MS = 6_000

function DepartureToast() {
  const [entry, setEntry] = useState<{ time: string; probability: number }>()

  useEffect(() => {
    let hideTimer: number | undefined
    const show = () => {
      const departure = new Date(Date.now() + DEPARTURE_TOAST_OFFSET_MINUTES * 60_000)
      const time = departure.toLocaleTimeString('ja-JP', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit' })
      const probability = 78 + Math.floor(Math.random() * 15)
      setEntry({ time, probability })
      window.clearTimeout(hideTimer)
      hideTimer = window.setTimeout(() => setEntry(undefined), DEPARTURE_TOAST_VISIBLE_MS)
    }
    show()
    const interval = window.setInterval(show, DEPARTURE_TOAST_INTERVAL_MS)
    return () => {
      window.clearInterval(interval)
      window.clearTimeout(hideTimer)
    }
  }, [])

  if (!entry) return null
  return <div className="departure-toast" role="status">
    <b>{entry.time}</b>（{DEPARTURE_TOAST_OFFSET_MINUTES}分後）に出発すると、現在地周辺の除雪が完了する予定です
    <small>除雪完了の確率 約{entry.probability}%</small>
  </div>
}

function DepartureRecommendationCard({ recommendation }: { recommendation: ApiDepartureRecommendation }) {
  if (recommendation.insufficient_data) {
    return <div className="ai-explanation departure-recommendation"><b>おすすめ出発時刻</b><p>除雪車の通過実績が少なく、出発時刻の予測はできません(情報不足)。</p></div>
  }
  if (recommendation.evaluated_segment_ids.length === 0) {
    return <div className="ai-explanation departure-recommendation"><b>おすすめ出発時刻</b><p>この経路の全区間で、直近60分以内に除雪車が通過した実績があります。今すぐの出発で問題ありません。</p><small>実績データに基づく判定です</small></div>
  }
  const bestCandidate = recommendation.candidates.find((item) => item.offset_minutes === recommendation.recommended_offset_minutes)
  const bestProbabilityPercent = Math.round((bestCandidate?.minimum_plow_probability ?? 0) * 100)
  if (!recommendation.meets_probability_threshold) {
    return <div className="ai-explanation departure-recommendation">
      <b>おすすめ出発時刻</b>
      <p>
        直近60分の除雪実績が確認できない区間があります。除雪車の通過間隔の統計予測では、今後90分以内に出発時刻をずらしても除雪済みとなっている確率は大きく改善しません（最も高い場合でも約{bestProbabilityPercent}%の推定）。
      </p>
      <small>予測（シミュレーション）・指数の判定には使用していません</small>
    </div>
  }
  if (recommendation.recommended_offset_minutes === 0) {
    return <div className="ai-explanation departure-recommendation">
      <b>おすすめ出発時刻</b>
      <p>
        直近60分の除雪実績が確認できない区間がありますが、除雪車の通過間隔の統計予測では、今すぐの出発でも除雪済みとなっている確率は約{bestProbabilityPercent}%と推定されます。今すぐの出発で問題ありません。
      </p>
      <small>予測（シミュレーション）・指数の判定には使用していません</small>
    </div>
  }
  return <div className="ai-explanation departure-recommendation">
    <b>おすすめ出発時刻</b>
    <div className="departure-time-highlight">
      <strong>{departureTimeLabel(recommendation.recommended_departure_time)}</strong>
      <span>（{recommendation.recommended_offset_minutes}分後）</span>
    </div>
    <p>
      直近60分の除雪実績が確認できない区間があります。除雪車の通過間隔の統計予測では、この時刻の出発だと除雪済みとなっている確率が約{bestProbabilityPercent}%まで高くなる見込みです。
    </p>
    <small>予測（シミュレーション）・指数の判定には使用していません</small>
  </div>
}

function RouteAiAccordion({ route, explanation, aiLoading }: { route: RecommendedRoute; explanation?: RouteExplanation; aiLoading: boolean }) {
  const routeExplanation = explanation?.routes.find((item) => item.routeId === route.id)
  if (!routeExplanation) {
    if (!aiLoading) return null
    return <div className="ai-explanation ai-loading" role="status"><div className="spinner"/>AIが経路を分析しています</div>
  }
  const isRecommended = explanation?.recommendedRouteId === route.id
  return <div className="ai-explanation">
    <b>AIによる説明</b>
    <p>{routeExplanation.summary}</p>
    {(routeExplanation.advantages.length > 0 || routeExplanation.cautions.length > 0) && <div className="reason-list">{routeExplanation.advantages.map((item) => <span key={item}>✓ {item}</span>)}{routeExplanation.cautions.map((item) => <span className="warn" key={item}>△ {item}</span>)}</div>}
    {isRecommended && explanation && <p className="ai-recommend-reason">{explanation.recommendationReason}</p>}
    <small>{explanation?.metadata.fallback_used ? '定型フォールバック' : 'AIによる生成'}</small>
  </div>
}

function RoutePanel({ routes,active,setActive,explanation,aiLoading,departureRecommendation,back,start }: { routes: RecommendedRoute[]; active: string; setActive: (id:string) => void; explanation?: RouteExplanation; aiLoading: boolean; departureRecommendation?: ApiDepartureRecommendation; back: () => void; start: () => void }) {
  return <section className="route-panel"><header><button className="icon-button" onClick={back} aria-label="ホームへ戻る">‹</button><div><b>ルートを選択</b><small>走りやすさの根拠を比較</small></div></header><div className="route-list">
    {departureRecommendation && <DepartureRecommendationCard recommendation={departureRecommendation}/>}
    {routes.map((route) => { const isActive = active === route.id; return <div className={`route-card-wrap ${isActive ? 'active' : ''}`} key={route.id}>
      <button className={`route-card ${isActive ? 'active' : ''}`} onClick={() => setActive(route.id)}><div><em>{route.label}</em>{route.label === 'AIおすすめ' && <mark>総合推薦</mark>}<h3>{route.durationMinutes}<small>分</small> <span>{route.distanceKm} km</span></h3></div><Score value={route.drivabilityScore}/><dl><div><dt>直近の除雪実績</dt><dd>{Math.round(route.plowedRatio * 100)}%</dd></div><div><dt>消雪パイプ区間</dt><dd>{Math.round(route.snowmeltPipeRatio * 100)}%</dd></div><div><dt>実績未確認区間</dt><dd>{route.noPlowRecordSegmentCount ?? 'API提供なし'}</dd></div></dl><p>{route.reasons.join('・')}</p>{route.warnings.map((warning) => <span className="route-warning" key={warning}>△ {warning}</span>)}</button>
      {isActive && <RouteAiAccordion route={route} explanation={explanation} aiLoading={aiLoading}/>}
    </div> })}
  </div><button className="primary start" onClick={start}>経路の全体を確認</button></section>
}

function NavigationPanel({ route,back }: { route?: RecommendedRoute; back: () => void }) { return <><section className="nav-instruction"><button onClick={back} aria-label="経路確認を終了">×</button><div className="turn">◇</div><div><h2>選択した経路を表示中</h2><p>ターンバイターン案内はMVP対象外です</p></div><div className="nav-tags"><span>消雪パイプ区間 {Math.round((route?.snowmeltPipeRatio ?? 0) * 100)}%</span><span>除雪確認区間 {Math.round((route?.plowedRatio ?? 0) * 100)}%</span>{route?.warnings.map((warning) => <span className="warning" key={warning}>△ {warning}</span>)}</div></section><section className="arrival"><div><b>{route?.durationMinutes ?? '--'}分</b><small>推定時間</small></div><div><b>{route?.distanceKm ?? '--'} km</b><small>距離</small></div><div><b>{route?.drivabilityScore ?? '--'}</b><small>平均指数</small></div><button onClick={back}>経路候補へ戻る</button></section></> }

export default function App() {
  return <main className="stage">
    <div className="phone"><ApplicationErrorBoundary><AppContent/></ApplicationErrorBoundary></div>
    <p className="demo-caption">Yukisaki インタラクティブデモ · 2026/01/23 長岡市</p>
  </main>
}
