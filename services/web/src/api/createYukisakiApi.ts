import { appConfig } from './config'
import type { YukisakiApi } from './contracts'
import { HttpYukisakiApi } from './httpYukisakiApi'
import { MockYukisakiApi } from '../data/mock/mockApi'

const mockApi = new MockYukisakiApi()

class FallbackApi implements YukisakiApi {
  constructor(private readonly primary: YukisakiApi, private readonly fallback: YukisakiApi) {}
  private call<T>(run: (api: YukisakiApi) => Promise<T>) { return run(this.primary).catch(() => run(this.fallback)) }
  getRoadSegments(bounds?: Parameters<YukisakiApi['getRoadSegments']>[0]) { return this.call((api) => api.getRoadSegments(bounds)) }
  getRoadConditions(ids?: string[]) { return this.call((api) => api.getRoadConditions(ids)) }
  getSnowmeltPipes(bounds?: Parameters<YukisakiApi['getSnowmeltPipes']>[0]) { return this.call((api) => api.getSnowmeltPipes(bounds)) }
  getSnowplows(bounds?: Parameters<YukisakiApi['getSnowplows']>[0]) { return this.call((api) => api.getSnowplows(bounds)) }
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
