import { nativeHttpText } from '../native/http.js'
import {
  SEARCH_BACKENDS,
  type SearchConfig,
  type SearchProviderId,
  type SearchSource,
} from './providers.js'

export type { SearchSource, SearchProviderId, SearchConfig } from './providers.js'

/** 自动模式下的尝试顺序：必应最快，DuckDuckGo 次之，维基百科兜底 */
export const AUTO_ORDER: SearchProviderId[] = ['bing', 'duckduckgo', 'wikipedia']

/** 去掉代码块、链接语法，截断过长的提问，避免把整段粘贴内容当查询 */
export const extractQuery = (text: string): string => {
  const cleaned = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, ' ')
    .replace(/[#>*_~]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  return cleaned.slice(0, 200)
}

const backendName = (id: SearchProviderId): string =>
  ({
    bing: 'Bing',
    duckduckgo: 'DuckDuckGo',
    searxng: 'SearXNG',
    wikipedia: 'Wikipedia',
    tavily: 'Tavily',
  })[id]

/**
 * 依次尝试数据源，返回首个有结果的来源。
 * 自动模式下某个源报错（被墙、限流、格式变了）不影响后面的兜底。
 */
export const runSearch = async (
  query: string,
  provider: SearchProviderId | 'auto',
  config: SearchConfig,
  signal?: AbortSignal
): Promise<{ sources: SearchSource[]; provider: SearchProviderId }> => {
  // 自动模式：必应 → DuckDuckGo →（配置了实例时）SearXNG → 维基百科
  const order =
    provider === 'auto'
      ? AUTO_ORDER.flatMap((id) =>
          id === 'wikipedia' && config.searxngUrl.trim() ? (['searxng', 'wikipedia'] as const) : [id]
        )
      : [provider]
  let lastError: unknown
  for (const id of order) {
    try {
      const sources = await SEARCH_BACKENDS[id](query, config, signal)
      if (sources.length > 0) {
        return { sources: sources.slice(0, config.limit), provider: id }
      }
    } catch (error) {
      lastError = error
    }
  }
  if (lastError) {
    throw lastError
  }
  return { sources: [], provider: order[0] }
}

/** 用 Jina Reader（开源项目 jina-ai/reader 的公开服务）抓正文，只取开头部分 */
export const readPageContent = async (url: string, signal?: AbortSignal): Promise<string> => {
  try {
    const response = await nativeHttpText(`https://r.jina.ai/${url}`, {
      headers: { Accept: 'text/plain' },
      signal,
      timeoutMs: 12000,
    })
    if (response.status !== 200) {
      return ''
    }
    const marker = response.body.indexOf('Markdown Content:')
    const text = marker >= 0 ? response.body.slice(marker + 'Markdown Content:'.length) : response.body
    return text.replace(/\n{3,}/g, '\n\n').trim().slice(0, 4000)
  } catch {
    return ''
  }
}

export type SearchOutcome = {
  provider: SearchProviderId
  sources: SearchSource[]
  prompt: string
}

const buildPrompt = (
  sources: SearchSource[],
  pages: Map<string, string>,
  provider: SearchProviderId,
  locale: 'zh-CN' | 'en-US'
): string => {
  const today = new Date().toISOString().slice(0, 10)
  const blocks = sources.map((source, index) => {
    const page = pages.get(source.url)
    const lines = [
      `[${index + 1}] ${source.title}`,
      locale === 'zh-CN' ? `链接：${source.url}` : `URL: ${source.url}`,
    ]
    if (source.snippet) {
      lines.push(locale === 'zh-CN' ? `摘要：${source.snippet}` : `Snippet: ${source.snippet}`)
    }
    if (page) {
      lines.push(
        locale === 'zh-CN' ? `正文节选：\n${page}` : `Page excerpt:\n${page}`
      )
    }
    return lines.join('\n')
  })
  if (locale === 'zh-CN') {
    return [
      `以下是 ${today} 通过 ${backendName(provider)} 联网搜索到的资料，请把它们当作事实依据。`,
      '回答要求：',
      '1. 优先依据下面的资料作答，资料里没有的信息不要编造；',
      '2. 在对应结论后用 [编号] 标注来源，例如 [1][2]；',
      '3. 资料不足或相互矛盾时明确说明，并指出还需要查什么。',
      '',
      blocks.join('\n\n'),
    ].join('\n')
  }
  return [
    `The following material was retrieved on ${today} via ${backendName(provider)} web search. Treat it as factual grounding.`,
    'Answer guidelines:',
    '1. Prefer this material and do not invent facts that are absent from it;',
    '2. Cite sources with [n] right after the statements they support, e.g. [1][2];',
    '3. If the material is insufficient or contradictory, say so and note what is still missing.',
    '',
    blocks.join('\n\n'),
  ].join('\n')
}

/**
 * 完整流程：搜索 → 可选地抓取前两篇正文 → 拼成注入给模型的前置说明。
 * 搜索失败时抛出原始错误，由调用方决定是否中断。
 */
export const searchForPrompt = async ({
  query,
  provider,
  config,
  readPages,
  signal,
}: {
  query: string
  provider: SearchProviderId | 'auto'
  config: SearchConfig
  readPages: boolean
  signal?: AbortSignal
}): Promise<SearchOutcome | null> => {
  if (!query.trim()) {
    return null
  }
  const { sources, provider: used } = await runSearch(query, provider, config, signal)
  if (sources.length === 0) {
    return null
  }
  const pages = new Map<string, string>()
  if (readPages) {
    const picked = sources.slice(0, 2)
    const settled = await Promise.allSettled(
      picked.map(async (source) => {
        const text = await readPageContent(source.url, signal)
        if (text) {
          pages.set(source.url, text)
        }
      })
    )
    void settled
  }
  return {
    provider: used,
    sources,
    prompt: buildPrompt(sources, pages, used, config.locale),
  }
}
