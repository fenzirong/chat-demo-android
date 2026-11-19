import { nativeHttpText } from '../native/http.js'

/**
 * 第三方服务商的联网搜索数据源。
 *
 * 这些数据源都是「免费、无需申请 Key」的公开入口，做法与开源项目一致：
 * - Bing RSS：`format=rss` 是必应长期保留的轻量输出，NextChat / ChatBox 一类客户端常用；
 * - DuckDuckGo HTML：开源的 duckduckgo-search 也是抓这个页面；
 * - SearXNG：AGPL 的元搜索，可自建，天然适合当私有搜索后端；
 * - Wikipedia API：开放且支持 CORS，作为最后兜底；
 * - Tavily：可选，自带免费额度，需要用户自己填 Key。
 *
 * 浏览器里这些站点普遍不放行跨域，因此优先走原生 HTTP 桥（Android 外壳）。
 */

export type SearchSource = {
  title: string
  url: string
  snippet: string
}

export type SearchProviderId = 'bing' | 'duckduckgo' | 'searxng' | 'wikipedia' | 'tavily'

export type SearchConfig = {
  searxngUrl: string
  tavilyKey: string
  limit: number
  locale: 'zh-CN' | 'en-US'
}

/** 桌面 Chrome UA：搜索引擎对不认识的 UA 会直接返回验证页 */
const USER_AGENT =
  'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'

const requestHeaders = (locale: SearchConfig['locale']): Record<string, string> => ({
  'User-Agent': USER_AGENT,
  'Accept-Language': locale === 'zh-CN' ? 'zh-CN,zh;q=0.9,en;q=0.8' : 'en-US,en;q=0.9',
})

/** 去掉标签、合并空白，摘要里常混着 <b> 高亮和实体 */
export const stripHtml = (html: string): string => {
  if (!html) {
    return ''
  }
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim()
}

const toResult = (title: string, url: string, snippet: string): SearchSource => ({
  title: (title || url).replace(/\s+/g, ' ').trim(),
  url: url.trim(),
  snippet: (snippet || '').replace(/\s+/g, ' ').trim(),
})

/** 必应 RSS：<item><title/><link/><description/> */
export const searchBing = async (
  query: string,
  config: SearchConfig,
  signal?: AbortSignal
): Promise<SearchSource[]> => {
  const url = `https://www.bing.com/search?q=${encodeURIComponent(query)}&format=rss&count=${config.limit}`
  const { status, body } = await nativeHttpText(url, {
    headers: requestHeaders(config.locale),
    signal,
  })
  if (status !== 200) {
    throw new Error(`bing ${status}`)
  }
  const doc = new DOMParser().parseFromString(body, 'text/xml')
  if (doc.querySelector('parsererror')) {
    throw new Error('bing rss parse failed')
  }
  return [...doc.querySelectorAll('item')]
    .slice(0, config.limit)
    .map((item) =>
      toResult(
        item.querySelector('title')?.textContent ?? '',
        item.querySelector('link')?.textContent ?? '',
        stripHtml(item.querySelector('description')?.textContent ?? '')
      )
    )
    .filter((item) => item.url.startsWith('http'))
}

/** DuckDuckGo 的结果链接是 /l/?uddg= 跳转，需要还原真实地址 */
const decodeDuckDuckGoUrl = (href: string): string => {
  const normalized = href.startsWith('//') ? `https:${href}` : href
  try {
    const parsed = new URL(normalized, 'https://duckduckgo.com')
    const target = parsed.searchParams.get('uddg')
    return target ? decodeURIComponent(target) : normalized
  } catch {
    return normalized
  }
}

export const searchDuckDuckGo = async (
  query: string,
  config: SearchConfig,
  signal?: AbortSignal
): Promise<SearchSource[]> => {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const { status, body } = await nativeHttpText(url, {
    headers: requestHeaders(config.locale),
    signal,
  })
  if (status !== 200) {
    throw new Error(`duckduckgo ${status}`)
  }
  const doc = new DOMParser().parseFromString(body, 'text/html')
  const results: SearchSource[] = []
  for (const anchor of doc.querySelectorAll('a.result__a')) {
    const result = toResult(
      anchor.textContent ?? '',
      decodeDuckDuckGoUrl(anchor.getAttribute('href') ?? ''),
      stripHtml(anchor.closest('.result')?.querySelector('.result__snippet')?.textContent ?? '')
    )
    if (result.url.startsWith('http')) {
      results.push(result)
    }
    if (results.length >= config.limit) {
      break
    }
  }
  return results
}

/** SearXNG 的 JSON 输出默认关闭，关闭时改抓 HTML 结果卡片 */
const parseSearxngHtml = (html: string, limit: number): SearchSource[] => {
  const doc = new DOMParser().parseFromString(html, 'text/html')
  return [...doc.querySelectorAll('article.result')]
    .slice(0, limit)
    .map((article) =>
      toResult(
        article.querySelector('h3')?.textContent ?? '',
        article.querySelector('h3 a')?.getAttribute('href') ?? '',
        article.querySelector('.content')?.textContent ?? ''
      )
    )
    .filter((item) => item.url.startsWith('http'))
}

export const searchSearxng = async (
  query: string,
  config: SearchConfig,
  signal?: AbortSignal
): Promise<SearchSource[]> => {
  const base = config.searxngUrl.trim().replace(/\/+$/, '')
  if (!base) {
    throw new Error('searxng 未配置实例地址')
  }
  const query$ = encodeURIComponent(query)
  const jsonResponse = await nativeHttpText(`${base}/search?q=${query$}&format=json&safesearch=0`, {
    headers: { ...requestHeaders(config.locale), Accept: 'application/json' },
    signal,
  })
  if (jsonResponse.status === 200) {
    try {
      const data = JSON.parse(jsonResponse.body) as {
        results?: { title?: string; url?: string; content?: string }[]
      }
      if (Array.isArray(data.results)) {
        return data.results
          .slice(0, config.limit)
          .map((item) => toResult(item.title ?? '', item.url ?? '', item.content ?? ''))
          .filter((item) => item.url.startsWith('http'))
      }
    } catch {
      // 非 JSON：实例关闭了 json 输出，走 HTML
    }
  }
  const htmlResponse = await nativeHttpText(`${base}/search?q=${query$}`, {
    headers: requestHeaders(config.locale),
    signal,
  })
  if (htmlResponse.status !== 200) {
    throw new Error(`searxng ${htmlResponse.status}`)
  }
  const results = parseSearxngHtml(htmlResponse.body, config.limit)
  if (results.length === 0) {
    throw new Error('searxng 无结果')
  }
  return results
}

/** Wikipedia：接口支持 origin=*，网页版也能直接用 */
export const searchWikipedia = async (
  query: string,
  config: SearchConfig,
  signal?: AbortSignal
): Promise<SearchSource[]> => {
  const lang = config.locale === 'zh-CN' ? 'zh' : 'en'
  const url =
    `https://${lang}.wikipedia.org/w/api.php?action=query&list=search` +
    `&srsearch=${encodeURIComponent(query)}&format=json&origin=*&srlimit=${config.limit}`
  const response = await nativeHttpText(url, {
    headers: { 'Accept-Language': requestHeaders(config.locale)['Accept-Language'] },
    signal,
  })
  if (response.status !== 200) {
    throw new Error(`wikipedia ${response.status}`)
  }
  const data = JSON.parse(response.body) as {
    query?: { search?: { title?: string; snippet?: string }[] }
  }
  return (data.query?.search ?? [])
    .slice(0, config.limit)
    .map((item) => {
      const title = item.title ?? ''
      return toResult(
        title,
        `https://${lang}.wikipedia.org/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`,
        stripHtml(item.snippet ?? '')
      )
    })
    .filter((item) => item.title !== '')
}

/** Tavily：自带免费额度，需要用户填 Key */
export const searchTavily = async (
  query: string,
  config: SearchConfig,
  signal?: AbortSignal
): Promise<SearchSource[]> => {
  const key = config.tavilyKey.trim()
  if (!key) {
    throw new Error('tavily 未配置 API Key')
  }
  const response = await nativeHttpText('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ api_key: key, query, max_results: config.limit, search_depth: 'basic' }),
    signal,
  })
  if (response.status !== 200) {
    throw new Error(`tavily ${response.status}`)
  }
  const data = JSON.parse(response.body) as {
    results?: { title?: string; url?: string; content?: string }[]
  }
  return (data.results ?? [])
    .slice(0, config.limit)
    .map((item) => toResult(item.title ?? '', item.url ?? '', item.content ?? ''))
    .filter((item) => item.url.startsWith('http'))
}

export const SEARCH_BACKENDS: Record<
  SearchProviderId,
  (query: string, config: SearchConfig, signal?: AbortSignal) => Promise<SearchSource[]>
> = {
  bing: searchBing,
  duckduckgo: searchDuckDuckGo,
  searxng: searchSearxng,
  wikipedia: searchWikipedia,
  tavily: searchTavily,
}
