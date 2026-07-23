import { appConfig } from './config'
import type { YukisakiApi } from './contracts'
import { HttpYukisakiApi } from './httpYukisakiApi'
import { MockYukisakiApi } from '../data/mock/mockApi'

const mockApi = new MockYukisakiApi()

class FallbackApi implements YukisakiApi {
  constructor(private readonly primary: YukisakiApi, private readonly fallback: YukisakiApi) {}
  private call<T>(run: (api: YukisakiApi) => Promise<T>) { return run(this.primary).catch(() => run(this.fallback)) }
  async getMapSnapshot(bounds?: Parameters<YukisakiApi['getMapSnapshot']>[0]) {
    try {
      const snapshot = await this.primary.getMapSnapshot(bounds)
      return snapshot
    } catch {
      return this.fallback.getMapSnapshot(bounds)
    }
  }
  async getMapRoadPage(
    bounds?: Parameters<YukisakiApi['getMapRoadPage']>[0],
    cursor?: Parameters<YukisakiApi['getMapRoadPage']>[1],
    signal?: Parameters<YukisakiApi['getMapRoadPage']>[2],
  ) {
    try {
      const page = await this.primary.getMapRoadPage(bounds, cursor, signal)
      return page
    } catch {
      return this.fallback.getMapRoadPage(bounds, cursor, signal)
    }
  }
  getRoadSegments(bounds?: Parameters<YukisakiApi['getRoadSegments']>[0], signal?: AbortSignal) { return this.call((api) => api.getRoadSegments(bounds, signal)) }
  getRoadConditions(ids?: string[]) { return this.call((api) => api.getRoadConditions(ids)) }
  getSnowmeltPipes(bounds?: Parameters<YukisakiApi['getSnowmeltPipes']>[0]) { return this.call((api) => api.getSnowmeltPipes(bounds)) }
  getSnowplows(bounds?: Parameters<YukisakiApi['getSnowplows']>[0], signal?: AbortSignal) {
    return this.call((api) => api.getSnowplows(bounds, signal))
  }
  getWeather(position: Parameters<YukisakiApi['getWeather']>[0]) { return this.call((api) => api.getWeather(position)) }
  getDestinations(query: string) { return this.call((api) => api.getDestinations(query)) }
  recommendRoutes(request: Parameters<YukisakiApi['recommendRoutes']>[0]) { return this.call((api) => api.recommendRoutes(request)) }
}

export function createYukisakiApi(): YukisakiApi {
  if (appConfig.dataMode === 'mock') return mockApi
  const http = new HttpYukisakiApi(appConfig.apiBaseUrl)
  return appConfig.mockFallback ? new FallbackApi(http, mockApi) : http
}

export const yukisakiApi = createYukisakiApi()
