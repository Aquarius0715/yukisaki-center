export const appConfig = {
  dataMode: import.meta.env.VITE_DATA_MODE === 'api' ? 'api' : 'mock',
  apiBaseUrl: (import.meta.env.VITE_YUKISAKI_API_URL || import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, ''),
  mapKitToken: import.meta.env.VITE_MAPKIT_TOKEN || '',
  mockFallback: import.meta.env.VITE_ENABLE_MOCK_FALLBACK !== 'false',
  demo: {
    dateTime: '2026-01-23T12:00:00+09:00',
    label: '2026年1月23日 12:00',
    area: '新潟県長岡市',
    position: { latitude: 37.443334, longitude: 138.88375 },
    bounds: { minLongitude: 138.643056, minLatitude: 37.176389, maxLongitude: 139.124444, maxLatitude: 37.710278 },
  },
} as const
