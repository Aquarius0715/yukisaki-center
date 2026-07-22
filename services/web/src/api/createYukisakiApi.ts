import { appConfig } from './config'
import type { YukisakiApi } from './contracts'
import { HttpYukisakiApi } from './httpYukisakiApi'
import { MockYukisakiApi } from '../data/mock/mockApi'

const mockApi = new MockYukisakiApi()

class FallbackApi implements YukisakiApi {
  private liveMapConnected = false
  constructor(private readonly primary: YukisakiApi, private readonly fallback: YukisakiApi) {}
  private call<T>(run: (api: YukisakiApi) => Promise<T>) { return run(this.primary).catch(() => run(this.fallback)) }
  async getMapSnapshot(bounds?: Parameters<YukisakiApi['getMapSnapshot']>[0]) {
    try {
      const snapshot = await this.primary.getMapSnapshot(bounds)
      this.liveMapConnected = true
      return snapshot
    } catch {
      this.liveMapConnected = false
      return this.fallback.getMapSnapshot(bounds)
    }
  }
  getRoadSegments(bounds?: Parameters<YukisakiApi['getRoadSegments']>[0]) { return this.call((api) => api.getRoadSegments(bounds)) }
  getRoadConditions(ids?: string[]) { return this.call((api) => api.getRoadConditions(ids)) }
  getSnowmeltPipes(bounds?: Parameters<YukisakiApi['getSnowmeltPipes']>[0]) { return this.call((api) => api.getSnowmeltPipes(bounds)) }
  getSnowplows(bounds?: Parameters<YukisakiApi['getSnowplows']>[0]) {
    return this.liveMapConnected ? this.primary.getSnowplows(bounds) : this.fallback.getSnowplows(bounds)
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
