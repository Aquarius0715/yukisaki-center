import { Component, useEffect, useState, type ErrorInfo, type ReactNode } from 'react'
import { appConfig } from './api/config'
import { yukisakiApi } from './api/createYukisakiApi'
import type {
  ApiRouteResponse,
  DangerExplanation,
  Destination,
  DestinationSuggestion,
  RecommendedRoute,
  RoadCondition,
  RoadSegmentFeature,
  RouteExplanation,
  Snowplow,
} from './api/contracts'
import { YukisakiMap, type LayerVisibility } from './features/map/YukisakiMap'
import { useYukisakiData } from './hooks/useYukisakiData'

type Screen = 'splash' | 'home' | 'routes' | 'navigation'
type Sheet = 'layers' | 'road' | 'plow' | undefined
// Keep the first paint intentionally light. Supplemental overlays remain
// available from the layer sheet and are created only when selected.
const defaultLayers: LayerVisibility = {
  drivability: true,
  snowmelt: false,
  plowing: false,
  plows: true,
  tracks: false,
  slopes: false,
  snowEffects: false,
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
  return <svg className={compact ? 'plow-art compact' : 'plow-art'} viewBox="0 0 180 100" role="img" aria-label="除雪車">
    <g className="snow-spray"><circle cx="18" cy="42" r="12"/><circle cx="7" cy="58" r="8"/><circle cx="25" cy="72" r="10"/></g>
    <path d="M25 40 58 51v32L25 92Z" fill="#d7e4ed" stroke="#91a6b8" strokeWidth="3"/>
    <rect x="52" y="40" width="95" height="43" rx="12" fill="#f4a51c"/><path d="M105 20h40a13 13 0 0 1 13 13v34h-53Z" fill="#e78c15"/>
    <path d="M114 27h27a9 9 0 0 1 9 9v14h-36Z" fill="#c8e7f8"/><rect x="122" y="12" width="13" height="10" rx="5" fill="#ef4b3f"/>
    <circle cx="76" cy="82" r="15" fill="#17202d"/><circle cx="76" cy="82" r="7" fill="#617080"/><circle cx="137" cy="82" r="15" fill="#17202d"/><circle cx="137" cy="82" r="7" fill="#617080"/>
  </svg>
}

function Splash({ onDone }: { onDone: () => void }) {
  useEffect(() => { const timer = window.setTimeout(onDone, 2800); return () => window.clearTimeout(timer) }, [onDone])
  return <button className="splash" onClick={onDone} aria-label="ホーム画面へ進む">
    <div className="snow-particles" aria-hidden="true">{Array.from({ length: 28 }, (_, i) => <i key={i} style={{ '--x': `${(i * 47) % 100}%`, '--d': `${(i % 7) * .35}s`, '--s': `${3 + i % 5}px` } as React.CSSProperties}/>)}</div>
    <div className="brand-mark">Y<span>❄</span></div><h1>Yukisaki</h1><p>雪の先に、走りやすい道を。</p>
    <div className="splash-road"><div className="revealed-road"/><div className="moving-plow"><SnowplowArt/></div></div>
    <small>タップしてはじめる</small>
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
  no_plow_history: '除雪実績なし',
  active_snow_pipe: '消雪パイプ作動中',
  light_hourly_snowfall: '弱い降雪',
  moderate_hourly_snowfall: '中程度の降雪',
  heavy_hourly_snowfall: '強い降雪',
  freezing_wet_condition: '凍結しやすい路面・気温',
}

function scoreValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return '情報なし'
  if (key === 'temperature_c') return `${value} ℃`
  if (key === 'snowfall_1h_cm') return `${value} cm`
  if (key === 'max_slope_percent') return `${value} %`
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
  const items: [keyof LayerVisibility,string,string][] = [['drivability','走りやすさ指数','低い道路は赤、高い道路は青'],['snowmelt','消雪パイプ','道路脇の水色ライン'],['plowing','除雪実績','道路面とタイヤ跡'],['plows','除雪車の現在地','5秒かけて次の位置へ移動'],['tracks','除雪車の走行軌跡','走行済みの道路'],['slopes','坂道','注意区間'],['snowEffects','雪のビジュアル演出','実測積雪量ではありません']]
  return <BottomSheet title="地図レイヤー" onClose={close}><div className="sheet-content layer-list">{items.map(([key,label,note]) => <label key={key}><span><b>{label}</b><small>{note}</small></span><input type="checkbox" checked={layers[key]} onChange={() => setLayers({ ...layers, [key]: !layers[key] })}/><i/></label>)}</div></BottomSheet>
}

function RoadSheet({ road, condition, close }: { road: RoadSegmentFeature; condition: ReturnType<typeof useYukisakiData>['conditions'][number] | undefined; close: () => void }) {
  const p = road.properties
  const sections = scoreSections(condition)
  return <BottomSheet title="道路区間の詳細" onClose={close}><div className="sheet-content">
    <div className="road-title"><div><small>{p.highway ?? '道路'}</small><h3>{p.road_name || p.name || '名称のない道路'}</h3><code>{p.segment_id}</code></div>{condition && <Score value={condition.drivabilityScore}/>}</div>
    <div className="fact-grid"><span>道幅<b>{condition?.roadWidthM ? `${condition.roadWidthM} m` : '情報なし'}</b></span><span>一方通行<b>{p.oneway === true || p.oneway === 'yes' ? 'はい' : 'いいえ'}</b></span><span>消雪パイプ<b>{condition?.hasSnowmeltPipe ? condition.snowmeltPipeOperating ? '作動中' : 'あり・停止中' : '設置情報なし'}</b></span><span>最終除雪車通過<b>{condition?.lastPlowedAt ? new Date(condition.lastPlowedAt).toLocaleString('ja-JP',{ timeZone:'Asia/Tokyo' }) : '走行実績を確認できません'}</b></span></div>
    <h4>APIが返したスコアの根拠</h4>{sections.map((section) => <section className="score-section" key={section.title}><h5>{section.title}</h5><div className="breakdown">{section.rows.map(({ key, label, value }) => { const numeric = typeof value === 'number' ? value : null; return <div key={key}><span>{label}</span><b className={numeric !== null && numeric < 0 ? 'minus' : ''}>{numeric !== null && numeric > 0 ? '+' : ''}{scoreValue(key, value)}</b></div> })}</div></section>)}
    {[...(condition?.reasons ?? []),...(condition?.warnings ?? [])].length > 0 && <div className="reason-list">{condition?.reasons.map((reason) => <span key={reason}>✓ {reason}</span>)}{condition?.warnings.map((warning) => <span className="warn" key={warning}>△ {warning}</span>)}</div>}
    <p className="data-note">更新: {condition?.updatedAt ? new Date(condition.updatedAt).toLocaleString('ja-JP',{ timeZone:'Asia/Tokyo' }) : '時刻情報なし'}・{condition?.isSimulated ? 'デモ用の仮データ' : 'APIデータ'}</p>
  </div></BottomSheet>
}

function PlowSheet({ plow, close }: { plow: Snowplow; close: () => void }) {
  return <BottomSheet title="除雪車の詳細" onClose={close}><div className="sheet-content"><div className="plow-heading"><div className="plow-icon"><SnowplowArt compact/></div><div><h3>{plow.name}</h3><span className="working-dot"/> {plow.status === 'working' ? '現在作業中' : plow.status === 'moving' ? '移動中' : '停止中'}</div></div>
    <div className="fact-grid"><span>速度<b>{plow.speedKmh} km/h</b></span><span>進行方向<b>{plow.heading}°</b></span><span>本日の除雪距離<b>{plow.todayDistanceKm === null ? 'API提供なし' : `${plow.todayDistanceKm} km`}</b></span><span>走行済み軌跡<b>{plow.track ? `${plow.track.coordinates.length} 地点` : 'API提供なし'}</b></span></div><div className="reason-list"><span>{plow.matchedSegmentId ? `✓ 道路 ${plow.matchedSegmentId} にマッチ` : '道路との紐付け情報なし'}</span><span>{plow.plannedRoute ? '→ 除雪予定ルートあり' : '予定ルート情報なし'}</span></div><p className="data-note">更新: {plow.lastUpdatedAt ? new Date(plow.lastUpdatedAt).toLocaleString('ja-JP',{ timeZone:'Asia/Tokyo' }) : '時刻情報なし'}・{plow.isSimulated ? 'デモ用GPS' : 'APIデータ'}</p>
  </div></BottomSheet>
}

function Header({ weather }: { weather?: ReturnType<typeof useYukisakiData>['weather'] }) { return <header className="topbar"><div className="mini-logo">Y❄ <b>Yukisaki</b></div><div className="weather"><span>❄ {weather?.temperatureC ?? '--'}°</span><small>{weather?.condition ?? '読込中'}</small></div></header> }

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
  const [plow, setPlow] = useState<Snowplow>()
  const [destination, setDestination] = useState<Destination>()
  const [routes, setRoutes] = useState<RecommendedRoute[]>([])
  const [activeRoute, setActiveRoute] = useState('')
  const [routeLoading, setRouteLoading] = useState(false)
  const [routeResponse, setRouteResponse] = useState<ApiRouteResponse>()
  const [routeExplanation, setRouteExplanation] = useState<RouteExplanation>()
  const [dangerExplanation, setDangerExplanation] = useState<DangerExplanation>()
  const [routeError, setRouteError] = useState<string>()
  const data = useYukisakiData()
  const condition = roadCondition ?? data.conditions.find((item) => item.segmentId === road?.properties.segment_id)
  const scoredConditions = data.conditions.filter((item) => item.hasDrivabilityScore !== false)
  const averageScore = scoredConditions.length ? Math.round(scoredConditions.reduce((sum,item) => sum + item.drivabilityScore,0) / scoredConditions.length) : 0

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
      const response = await yukisakiApi.recommendRoutes({
        origin: appConfig.demo.position,
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
      if (response.apiResponse) {
        const [explanation, danger] = await Promise.allSettled([
          yukisakiApi.explainRoutes(response.apiResponse),
          yukisakiApi.explainDangerPoints(response.apiResponse, selectedId),
        ])
        if (explanation.status === 'fulfilled') setRouteExplanation(explanation.value)
        if (danger.status === 'fulfilled') setDangerExplanation(danger.value)
      }
    } catch (error) {
      const status = error && typeof error === 'object' && 'status' in error ? Number(error.status) : undefined
      setRouteError(status === 409
        ? '経路探索用の道路グラフがまだロードされていません。'
        : '経路APIを利用できませんでした。環境の起動状態を確認してください。')
    } finally {
      setRouteLoading(false)
    }
  }

  const selectRoad = (item: RoadSegmentFeature) => {
    setRoad(item)
    setRoadCondition(data.conditions.find((entry) => entry.segmentId === item.properties.segment_id))
    setSheet('road')
    yukisakiApi.getRoadSegment(item.properties.segment_id).then((detail) => {
      setRoad(detail.road)
      setRoadCondition(detail.condition)
    }).catch(() => undefined)
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
    <YukisakiMap roads={data.roads} conditions={data.conditions} snowplows={data.snowplows} layers={layers} destination={destination} routes={screen === 'routes' || screen === 'navigation' ? routes : undefined} activeRouteId={activeRoute} onRoadSelect={selectRoad} onPlowSelect={(item) => { setPlow(item); setSheet('plow') }} onMapDestination={selectDestination} onViewportChange={data.refreshMap} animateSnowplows/>
    {layers.snowEffects && <div className="map-snow" aria-hidden="true"/>}
    {screen === 'home' && <><Search onChoose={selectDestination}/><div className="map-actions"><button onClick={() => setSheet('layers')} aria-label="地図レイヤーを選択">◇</button></div><div className="legend"><b>走りやすさ指数</b><span className="score-gradient"/><small><em>注意 0–59</em><em>60–74</em><em>75–84</em><em>良好 85–100</em></small><span className="legend-unknown"><i/>未算出</span></div>{routeError && <div className="api-warning route-error" role="alert"><b>経路探索エラー</b><span>{routeError}</span></div>}{data.updateStopped && <div className="api-warning" role="alert"><b>更新停止</b><span>最後に取得したデータを表示しています</span></div>}{data.viewportRefreshing && <div className="api-warning truncated" role="status"><b>表示範囲を更新中</b><span>道路データを再取得しています</span></div>}<section className="home-card"><div><small>現在地周辺の走りやすさ</small><h2>{appConfig.demo.area}</h2><p>消雪パイプ・除雪車通過実績・道路属性を表示</p></div><Score value={averageScore}/><footer><span>更新 {data.meta?.dataTimestamp ? new Date(data.meta.dataTimestamp).toLocaleString('ja-JP',{ timeZone:'Asia/Tokyo' }) : appConfig.demo.label}</span><b>{data.apiOnline === false ? 'API停止中' : data.meta?.source === 'api' ? 'API・デモデータ' : 'モックデータ'}</b></footer><div className="home-actions"><button className="primary" onClick={() => document.querySelector<HTMLInputElement>('.search input')?.focus()}>目的地を設定</button></div></section></>}
    {screen === 'routes' && <RoutePanel routes={routes} active={activeRoute} setActive={selectRoute} explanation={routeExplanation} danger={dangerExplanation} back={() => setScreen('home')} start={() => setScreen('navigation')}/>}
    {screen === 'navigation' && <NavigationPanel route={routes.find((item) => item.id === activeRoute)} back={() => setScreen('home')}/>} 
    {routeLoading && <div className="route-loading" role="status"><div className="spinner"/>ルート候補を準備しています</div>}
    {sheet === 'layers' && <LayerSheet layers={layers} setLayers={setLayers} close={() => setSheet(undefined)}/>} {sheet === 'road' && road && <RoadSheet road={road} condition={condition} close={() => setSheet(undefined)}/>} {sheet === 'plow' && plow && <PlowSheet plow={plow} close={() => setSheet(undefined)}/>}
  </div>
}

function RoutePanel({ routes,active,setActive,explanation,danger,back,start }: { routes: RecommendedRoute[]; active: string; setActive: (id:string) => void; explanation?: RouteExplanation; danger?: DangerExplanation; back: () => void; start: () => void }) {
  const selectedExplanation = explanation?.routes.find((item) => item.routeId === active)
  return <section className="route-panel"><header><button className="icon-button" onClick={back} aria-label="ホームへ戻る">‹</button><div><b>ルートを選択</b><small>走りやすさの根拠を比較</small></div></header><div className="route-list">
    {explanation && <div className="ai-explanation"><b>AIによる比較説明</b><p>{explanation.recommendationReason}</p>{selectedExplanation && <p>{selectedExplanation.summary}</p>}<small>{explanation.metadata.fallback_used ? '定型フォールバック' : explanation.metadata.model_id}</small></div>}
    {danger && danger.hazards.length > 0 && <div className="danger-explanation"><b>注意箇所</b>{danger.hazards.map((hazard) => <p key={hazard.hazardId}>{hazard.explanation} {hazard.cautions.join('、')}</p>)}</div>}
    {routes.map((route, index) => <button className={`route-card ${active === route.id ? 'active' : ''}`} key={route.id} onClick={() => setActive(route.id)}><div><em>{route.label}</em>{index === 0 && <mark>探索1位</mark>}<h3>{route.durationMinutes}<small>分</small> <span>{route.distanceKm} km</span></h3></div><Score value={route.drivabilityScore}/><dl><div><dt>直近の除雪実績</dt><dd>{Math.round(route.plowedRatio * 100)}%</dd></div><div><dt>消雪パイプ区間</dt><dd>{Math.round(route.snowmeltPipeRatio * 100)}%</dd></div><div><dt>実績未確認区間</dt><dd>{route.noPlowRecordSegmentCount ?? 'API提供なし'}</dd></div></dl><p>{route.reasons.join('・')}</p>{route.warnings.map((warning) => <span className="route-warning" key={warning}>△ {warning}</span>)}</button>)}
  </div><button className="primary start" onClick={start}>経路の全体を確認</button></section>
}

function NavigationPanel({ route,back }: { route?: RecommendedRoute; back: () => void }) { return <><section className="nav-instruction"><button onClick={back} aria-label="経路確認を終了">×</button><div className="turn">◇</div><div><h2>選択した経路を表示中</h2><p>ターンバイターン案内はMVP対象外です</p></div><div className="nav-tags"><span>消雪パイプ区間 {Math.round((route?.snowmeltPipeRatio ?? 0) * 100)}%</span><span>除雪確認区間 {Math.round((route?.plowedRatio ?? 0) * 100)}%</span>{route?.warnings.map((warning) => <span className="warning" key={warning}>△ {warning}</span>)}</div></section><section className="arrival"><div><b>{route?.durationMinutes ?? '--'}分</b><small>推定時間</small></div><div><b>{route?.distanceKm ?? '--'} km</b><small>距離</small></div><div><b>{route?.drivabilityScore ?? '--'}</b><small>平均指数</small></div><button onClick={back}>経路候補へ戻る</button></section></> }

export default function App() {
  return <main className="stage">
    <div className="phone"><ApplicationErrorBoundary><AppContent/></ApplicationErrorBoundary></div>
    <p className="demo-caption">Yukisaki interactive demo · 2026/01/23 長岡市</p>
  </main>
}
