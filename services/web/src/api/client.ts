export class PublicApiError extends Error {
  constructor(message: string, readonly status?: number) { super(message) }
}

export async function requestJson<T>(url: string, init: RequestInit = {}, timeoutMs = 10_000): Promise<T> {
  const controller = new AbortController()
  const externalSignal = init.signal
  const abortFromExternal = () => controller.abort()
  if (externalSignal?.aborted) controller.abort()
  else externalSignal?.addEventListener('abort', abortFromExternal, { once: true })
  const timer = window.setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...init, signal: controller.signal, headers: { Accept: 'application/json', ...init.headers } })
    if (!response.ok) throw new PublicApiError('データを取得できませんでした。', response.status)
    try { return await response.json() as T } catch { throw new PublicApiError('受信データの形式が正しくありません。') }
  } catch (error) {
    if (error instanceof PublicApiError) throw error
    if (error instanceof DOMException && error.name === 'AbortError') throw new PublicApiError('通信がタイムアウトしました。')
    throw new PublicApiError('通信に失敗しました。接続を確認してください。')
  } finally {
    window.clearTimeout(timer)
    externalSignal?.removeEventListener('abort', abortFromExternal)
  }
}

export function withQuery(path: string, values: Record<string, string | undefined>): string {
  const url = new URL(path, window.location.origin)
  Object.entries(values).forEach(([key, value]) => { if (value !== undefined) url.searchParams.set(key, value) })
  return `${url.pathname}${url.search}`
}
