import { appConfig } from './config'
import type { YukisakiApi } from './contracts'
import { HttpYukisakiApi } from './httpYukisakiApi'
import { MockYukisakiApi } from '../data/mock/mockApi'

const mockApi = new MockYukisakiApi()

class FallbackApi implements YukisakiApi {
  constructor(private readonly primary: YukisakiApi, private readonly fallback: YukisakiApi) {}
  private call<T>(run: (api: YukisakiApi) => Promise<T>) { return run(this.primary).catch(() => run(this.fallback)) }
  getHealth(signal?: AbortSignal) { return this.primary.getHealth(signal) }
  async getMapSnapshot(bounds?: Parameters<YukisakiApi['getMapSnapshot']>[0]) {
    return this.primary.getMapSnapshot(bounds)
  }
  async getMapRoadPage(
    bounds?: Parameters<YukisakiApi['getMapRoadPage']>[0],
    cursor?: Parameters<YukisakiApi['getMapRoadPage']>[1],
    signal?: Parameters<YukisakiApi['getMapRoadPage']>[2],
    limit?: Parameters<YukisakiApi['getMapRoadPage']>[3],
  ) {
    return this.primary.getMapRoadPage(bounds, cursor, signal, limit)
  }
  getRoadSegments(bounds?: Parameters<YukisakiApi['getRoadSegments']>[0], signal?: AbortSignal) { return this.primary.getRoadSegments(bounds, signal) }
  getRoadSegment(segmentId: string, signal?: AbortSignal) { return this.primary.getRoadSegment(segmentId, signal) }
  getRoadConditions(ids?: string[]) { return this.call((api) => api.getRoadConditions(ids)) }
  getSnowmeltPipes(bounds?: Parameters<YukisakiApi['getSnowmeltPipes']>[0]) { return this.call((api) => api.getSnowmeltPipes(bounds)) }
  getSnowplows(bounds?: Parameters<YukisakiApi['getSnowplows']>[0], signal?: AbortSignal) {
    return this.call((api) => api.getSnowplows(bounds, signal))
  }
  getWeather(position: Parameters<YukisakiApi['getWeather']>[0]) { return this.call((api) => api.getWeather(position)) }
  autocompleteDestinations(query: string, signal?: AbortSignal) { return this.primary.autocompleteDestinations(query, signal) }
  getDestinations(query: string) { return this.primary.getDestinations(query) }
  recommendRoutes(request: Parameters<YukisakiApi['recommendRoutes']>[0]) { return this.primary.recommendRoutes(request) }
  parseRouteRequest(text: string) { return this.primary.parseRouteRequest(text) }
  explainRoutes(routes: Parameters<YukisakiApi['explainRoutes']>[0]) { return this.primary.explainRoutes(routes) }
  explainDangerPoints(
    routes: Parameters<YukisakiApi['explainDangerPoints']>[0],
    routeId: Parameters<YukisakiApi['explainDangerPoints']>[1],
  ) { return this.primary.explainDangerPoints(routes, routeId) }
}

export function createYukisakiApi(): YukisakiApi {
  if (appConfig.dataMode === 'mock') return mockApi
  const http = new HttpYukisakiApi(appConfig.apiBaseUrl)
  return appConfig.mockFallback ? new FallbackApi(http, mockApi) : http
}

export const yukisakiApi = createYukisakiApi()
