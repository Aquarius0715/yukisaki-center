export const appConfig = {
  dataMode: import.meta.env.VITE_DATA_MODE === 'api' ? 'api' : 'mock',
  apiBaseUrl: (import.meta.env.VITE_API_BASE_URL || '').replace(/\/$/, ''),
  mapTileUrl: import.meta.env.VITE_MAP_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  mockFallback: import.meta.env.VITE_ENABLE_MOCK_FALLBACK !== 'false',
  demo: {
    dateTime: '2026-01-23T12:00:00+09:00',
    label: '2026年1月23日 12:00',
    area: '新潟県長岡市石動南町',
    position: { latitude: 37.442762, longitude: 138.790865 },
  },
} as const
