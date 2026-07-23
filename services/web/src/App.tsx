import { useEffect, useMemo, useState } from 'react'
import { appConfig } from './api/config'
import { yukisakiApi } from './api/createYukisakiApi'
import type { Destination, RecommendedRoute, RoadSegmentFeature, Snowplow } from './api/contracts'
import { YukisakiMap, type LayerVisibility } from './features/map/YukisakiMap'
import { useYukisakiData } from './hooks/useYukisakiData'

type Screen = 'splash' | 'home' | 'routes' | 'navigation'
type Sheet = 'layers' | 'road' | 'plow' | undefined
const defaultLayers: LayerVisibility = { drivability: true, snowmelt: true, plowing: true, plows: true, tracks: true, slopes: false, snowEffects: true }

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

function LayerSheet({ layers, setLayers, close }: { layers: LayerVisibility; setLayers: (layers: LayerVisibility) => void; close: () => void }) {
  const items: [keyof LayerVisibility,string,string][] = [['drivability','走りやすさ指数','低い道路は赤、高い道路は青'],['snowmelt','消雪パイプ','道路脇の水色ライン'],['plowing','除雪実績','道路面とタイヤ跡'],['plows','除雪車の現在地','5秒かけて次の位置へ移動'],['tracks','除雪車の走行軌跡','走行済みの道路'],['slopes','坂道','注意区間'],['snowEffects','雪のビジュアル演出','実測積雪量ではありません']]
  return <BottomSheet title="地図レイヤー" onClose={close}><div className="sheet-content layer-list">{items.map(([key,label,note]) => <label key={key}><span><b>{label}</b><small>{note}</small></span><input type="checkbox" checked={layers[key]} onChange={() => setLayers({ ...layers, [key]: !layers[key] })}/><i/></label>)}</div></BottomSheet>
}

function RoadSheet({ road, condition, close }: { road: RoadSegmentFeature; condition: ReturnType<typeof useYukisakiData>['conditions'][number] | undefined; close: () => void }) {
  const p = road.properties
  const breakdown = condition?.scoreBreakdown
  const scoreRows: Array<readonly [string, number | boolean | string | null]> = condition?.scoreFactorDetails?.map((factor) => [factor.label, factor.value] as const) ?? (breakdown ? [['基本点',breakdown.base],['消雪パイプ',breakdown.snowmeltPipe],['稼働状態',breakdown.snowmeltPipeOperation],['除雪実績',breakdown.recentPlowing],['道路種別',breakdown.roadClass],['道幅',breakdown.roadWidth],['坂道',breakdown.slope],['情報の新しさ',breakdown.dataFreshness]] as const : [])
  return <BottomSheet title="道路区間の詳細" onClose={close}><div className="sheet-content">
    <div className="road-title"><div><small>{p.highway ?? '道路'}</small><h3>{p.road_name || p.name || '名称のない道路'}</h3><code>{p.segment_id}</code></div>{condition && <Score value={condition.drivabilityScore}/>}</div>
    <div className="fact-grid"><span>道幅<b>{condition?.roadWidthM ? `${condition.roadWidthM} m` : '情報なし'}</b></span><span>一方通行<b>{p.oneway === true || p.oneway === 'yes' ? 'はい' : 'いいえ'}</b></span><span>消雪パイプ<b>{condition?.hasSnowmeltPipe ? condition.snowmeltPipeOperating ? '作動中' : 'あり・停止中' : '設置情報なし'}</b></span><span>最終除雪車通過<b>{condition?.lastPlowedAt ? new Date(condition.lastPlowedAt).toLocaleString('ja-JP',{ timeZone:'Asia/Tokyo' }) : '走行実績を確認できません'}</b></span></div>
    <h4>APIが返したスコアの根拠</h4><div className="breakdown">{scoreRows.map(([label,value]) => { const numeric = typeof value === 'number' ? value : null; return <div key={label}><span>{label}</span><b className={numeric !== null && numeric < 0 ? 'minus' : ''}>{numeric !== null && numeric > 0 ? '+' : ''}{displayValue(value)}</b></div> })}</div>
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
  const [query,setQuery] = useState(''); const [items,setItems] = useState<Destination[]>([]); const [open,setOpen] = useState(false)
  useEffect(() => { let active = true; const timer = window.setTimeout(() => yukisakiApi.getDestinations(query).then((value) => { if (active) setItems(value) }), 150); return () => { active = false; window.clearTimeout(timer) } }, [query])
  return <div className="search-wrap"><label className="search"><span>⌕</span><input value={query} onFocus={() => setOpen(true)} onChange={(event) => { setQuery(event.target.value); setOpen(true) }} placeholder="目的地を検索" aria-label="目的地を検索"/></label>{open && <div className="search-results">{items.map((item) => <button key={item.id} onClick={() => { onChoose(item); setQuery(item.name); setOpen(false) }}><b>{item.name}</b><small>{item.address}</small></button>)}<p>地図を右クリックしても目的地を設定できます</p></div>}</div>
}

function AppContent() {
  const [screen,setScreen] = useState<Screen>('splash'); const [sheet,setSheet] = useState<Sheet>(); const [layers,setLayers] = useState(defaultLayers)
  const [road,setRoad] = useState<RoadSegmentFeature>(); const [plow,setPlow] = useState<Snowplow>(); const [destination,setDestination] = useState<Destination>()
  const [routes,setRoutes] = useState<RecommendedRoute[]>([]); const [activeRoute,setActiveRoute] = useState('recommended'); const [routeLoading,setRouteLoading] = useState(false)
  const [mapDetailMode,setMapDetailMode] = useState(true)
  const data = useYukisakiData(); const condition = useMemo(() => data.conditions.find((item) => item.segmentId === road?.properties.segment_id), [data.conditions,road])
  const scoredConditions = data.conditions.filter((item) => item.hasDrivabilityScore !== false)
  const averageScore = scoredConditions.length ? Math.round(scoredConditions.reduce((sum,item) => sum + item.drivabilityScore,0) / scoredConditions.length) : 0
  const selectDestination = (item: Destination) => { setDestination(item); if (!data.roads) return; setRouteLoading(true); yukisakiApi.recommendRoutes({ origin: appConfig.demo.position, destination: item, preference: 'recommended' }).then((response) => { setRoutes(response.routes); setActiveRoute('recommended'); setScreen('routes') }).finally(() => setRouteLoading(false)) }

  if (screen === 'splash') return <Splash onDone={() => setScreen('home')}/>
  if (data.loading || !data.roads) return <div className="loading" role="status" aria-live="polite"><div className="spinner"/><b>道路データを読み込んでいます</b><small>長岡市石動南町・デモデータ</small></div>
  if (data.error) return <div className="loading" role="alert"><b>{data.error}</b><button className="primary" onClick={data.retry}>再試行</button></div>
  return <div className="app-screen"><Header weather={data.weather}/>
    <YukisakiMap roads={data.roads} conditions={data.conditions} snowplows={data.snowplows} layers={layers} destination={destination} routes={screen === 'routes' || screen === 'navigation' ? routes : undefined} activeRouteId={activeRoute} onRoadSelect={(item) => { setRoad(item); setSheet('road') }} onPlowSelect={(item) => { setPlow(item); setSheet('plow') }} onMapDestination={selectDestination} onViewportChange={data.loadViewport} onDetailModeChange={setMapDetailMode} animateSnowplows/>
    {layers.snowEffects && <div className="map-snow" aria-hidden="true"/>}
    {screen === 'home' && <><Search onChoose={selectDestination}/><div className="map-actions"><button onClick={() => setSheet('layers')} aria-label="地図レイヤーを選択">◇</button><button aria-label="現在地へ移動">◎</button></div><div className="legend"><b>走りやすさ指数</b><span className="score-gradient"/><small><em>注意 0–59</em><em>60–74</em><em>75–84</em><em>良好 85–100</em></small><span className="legend-unknown"><i/>未算出</span></div>{!mapDetailMode && <div className="api-warning zoom-hint" role="status"><b>地図を拡大してください</b><span>道路ごとの指数は町より近い縮尺で表示します</span></div>}{data.viewportLoading && mapDetailMode && <div className="map-data-loading" role="status">表示範囲の道路を更新中…</div>}{data.viewportError && <div className="api-warning viewport-error" role="alert"><b>道路の更新に失敗</b><span>{data.viewportError}</span></div>}{data.updateStopped && <div className="api-warning" role="alert"><b>更新停止</b><span>最後に取得したデータを表示しています</span></div>}{data.meta?.truncated && <div className="api-warning truncated" role="status"><b>さらに拡大してください</b><span>道路データが取得上限に達しました</span></div>}<section className="home-card"><div><small>現在地周辺の走りやすさ</small><h2>{appConfig.demo.area}</h2><p>消雪パイプ・除雪車通過実績・道路属性を表示</p></div><Score value={averageScore}/><footer><span>更新 {data.meta?.dataTimestamp ? new Date(data.meta.dataTimestamp).toLocaleString('ja-JP',{ timeZone:'Asia/Tokyo' }) : appConfig.demo.label}</span><b>{data.meta?.source === 'api' ? 'API・デモデータ' : 'API未接続・モック'}</b></footer><button className="primary" onClick={() => document.querySelector<HTMLInputElement>('.search input')?.focus()}>目的地を設定</button></section></>}
    {screen === 'routes' && <RoutePanel routes={routes} active={activeRoute} setActive={setActiveRoute} back={() => setScreen('home')} start={() => setScreen('navigation')}/>} 
    {screen === 'navigation' && <NavigationPanel route={routes.find((item) => item.id === activeRoute)} back={() => setScreen('home')}/>} 
    {routeLoading && <div className="route-loading" role="status"><div className="spinner"/>ルート候補を準備しています</div>}
    {sheet === 'layers' && <LayerSheet layers={layers} setLayers={setLayers} close={() => setSheet(undefined)}/>} {sheet === 'road' && road && <RoadSheet road={road} condition={condition} close={() => setSheet(undefined)}/>} {sheet === 'plow' && plow && <PlowSheet plow={plow} close={() => setSheet(undefined)}/>} 
  </div>
}

function RoutePanel({ routes,active,setActive,back,start }: { routes: RecommendedRoute[]; active: string; setActive: (id:string) => void; back: () => void; start: () => void }) {
  return <section className="route-panel"><header><button className="icon-button" onClick={back} aria-label="ホームへ戻る">‹</button><div><b>ルートを選択</b><small>走りやすさの根拠を比較</small></div></header><div className="route-list">{routes.map((route) => <button className={`route-card ${active === route.id ? 'active' : ''}`} key={route.id} onClick={() => setActive(route.id)}><div><em>{route.label}</em>{route.id === 'recommended' && <mark>おすすめ</mark>}<h3>{route.durationMinutes}<small>分</small> <span>{route.distanceKm} km</span></h3></div><Score value={route.drivabilityScore}/><dl><div><dt>直近の除雪実績</dt><dd>{Math.round(route.plowedRatio * 100)}%</dd></div><div><dt>消雪パイプ区間</dt><dd>{Math.round(route.snowmeltPipeRatio * 100)}%</dd></div><div><dt>実績を確認できない区間</dt><dd>{route.noPlowRecordSegmentCount}</dd></div></dl><p>{route.reasons.join('・')}</p>{route.warnings.map((warning) => <span className="route-warning" key={warning}>△ {warning}</span>)}</button>)}</div><button className="primary start" onClick={start}>このルートで案内開始</button></section>
}

function NavigationPanel({ route,back }: { route?: RecommendedRoute; back: () => void }) { return <><section className="nav-instruction"><button onClick={back} aria-label="ナビを終了">×</button><div className="turn">↱</div><div><h2>300 m先を右折</h2><p>県道23号</p></div><div className="nav-tags"><span>💧 この先 消雪パイプ</span><span>🚛 12分前に通過</span>{route?.warnings.map((warning) => <span className="warning" key={warning}>△ {warning}</span>)}</div></section><section className="arrival"><div><b>{route?.durationMinutes ?? 18}分</b><small>到着まで</small></div><div><b>{route?.distanceKm ?? 6.2} km</b><small>残り</small></div><div><b>12:18</b><small>到着予定</small></div><button>↗ より走りやすいルート</button></section></> }

export default function App() { return <main className="stage"><div className="phone"><AppContent/></div><p className="demo-caption">Yukisaki interactive demo · 2026/01/23 長岡市</p></main> }
