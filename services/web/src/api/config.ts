export const appConfig = {
  dataMode: import.meta.env.VITE_DATA_MODE === 'api' ? 'api' : 'mock',
  apiBaseUrl: (import.meta.env.VITE_YUKISAKI_API_URL || import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, ''),
  mapTileUrl: import.meta.env.VITE_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  mockFallback: import.meta.env.VITE_ENABLE_MOCK_FALLBACK !== 'false',
  demo: {
    dateTime: '2026-01-23T12:00:00+09:00',
    label: '2026年1月23日 12:00',
    area: '新潟県長岡市石動南町',
    position: { latitude: 37.442762, longitude: 138.790865 },
    bounds: { minLongitude: 138.74, minLatitude: 37.40, maxLongitude: 138.84, maxLatitude: 37.49 },
  },
} as const
