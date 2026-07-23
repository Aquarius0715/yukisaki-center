const MAPKIT_SCRIPT_ID = 'yukisaki-mapkit-js'
const MAPKIT_CALLBACK = '__yukisakiMapKitReady'

let loadPromise: Promise<typeof mapkit> | undefined

export function loadMapKit(token: string): Promise<typeof mapkit> {
  if (window.mapkit?.loadedLibraries.length) return Promise.resolve(window.mapkit)
  if (!token) return Promise.reject(new Error('VITE_MAPKIT_TOKEN が設定されていません'))
  if (loadPromise) return loadPromise

  const pending = new Promise<typeof mapkit>((resolve, reject) => {
    const finish = () => {
      if (!window.mapkit) {
        reject(new Error('MapKit JSを初期化できませんでした'))
        return
      }
      resolve(window.mapkit)
    }
    window[MAPKIT_CALLBACK] = finish

    const existing = document.getElementById(MAPKIT_SCRIPT_ID) as HTMLScriptElement | null
    if (existing) {
      existing.addEventListener('error', () => reject(new Error('MapKit JSを読み込めませんでした')), { once: true })
      return
    }

    const script = document.createElement('script')
    script.id = MAPKIT_SCRIPT_ID
    script.src = 'https://cdn.apple-mapkit.com/mk/5.x.x/mapkit.js'
    script.crossOrigin = 'anonymous'
    script.async = true
    script.dataset.callback = MAPKIT_CALLBACK
    script.dataset.libraries = 'full-map'
    script.dataset.token = token
    script.addEventListener('error', () => reject(new Error('MapKit JSを読み込めませんでした')), { once: true })
    document.head.appendChild(script)
  })
  loadPromise = pending.finally(() => {
    delete window[MAPKIT_CALLBACK]
  })
  return loadPromise
}
