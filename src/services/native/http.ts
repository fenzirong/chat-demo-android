/**
 * 原生 HTTP 桥。
 *
 * 浏览器里的 fetch 受同源策略约束，而搜索引擎、部分第三方接口都不放行跨域；
 * Android 外壳里由 Java 侧代发请求，再把响应文本回传给页面，等于绕开 CORS。
 * 网页版没有这个桥，会退回普通 fetch，只能访问允许跨域的接口。
 */

export type HttpResult = { status: number; body: string }

export type HttpOptions = {
  method?: string
  headers?: Record<string, string>
  body?: string
  signal?: AbortSignal
  timeoutMs?: number
}

type Bridge = {
  httpRequest: (
    id: string,
    method: string,
    url: string,
    headersJson: string,
    body: string
  ) => void
}

type NativeCallback = (id: string, status: number, body: string) => void

const pending = new Map<string, (status: number, body: string) => void>()
let sequence = 0

const getBridge = (): Bridge | undefined =>
  (globalThis as { AndroidBridge?: Bridge }).AndroidBridge

/** 是否运行在带原生桥的壳里（当前只有 Android WebView 提供） */
export const hasNativeHttp = (): boolean => typeof getBridge()?.httpRequest === 'function'

/** 原生侧通过 evaluateJavascript 回调这个入口 */
const registerCallback = () => {
  if (typeof window === 'undefined') {
    return
  }
  ;(window as unknown as { __chatDemoNativeHttp?: NativeCallback }).__chatDemoNativeHttp = (
    id,
    status,
    body
  ) => {
    const resolve = pending.get(id)
    if (resolve) {
      pending.delete(id)
      resolve(status, body)
    }
  }
}

registerCallback()

export const nativeHttpText = async (url: string, options: HttpOptions = {}): Promise<HttpResult> => {
  const { method = 'GET', headers = {}, body = '', signal, timeoutMs = 20000 } = options
  const bridge = getBridge()
  if (!bridge?.httpRequest) {
    const response = await fetch(url, {
      method,
      headers,
      body: body === '' ? undefined : body,
      signal,
    })
    return { status: response.status, body: await response.text() }
  }
  const id = `req${++sequence}`
  return new Promise<HttpResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error('timeout'))
    }, timeoutMs)
    const onAbort = () => {
      pending.delete(id)
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    pending.set(id, (status, text) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve({ status, body: text })
    })
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      bridge.httpRequest(id, method, url, JSON.stringify(headers), body)
    } catch (error) {
      pending.delete(id)
      clearTimeout(timer)
      reject(error instanceof Error ? error : new Error(String(error)))
    }
  })
}
