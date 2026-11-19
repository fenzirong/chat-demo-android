/**
 * API 服务商配置：协议、鉴权方式与能力开关。
 *
 * 上游 chat-demo 只对接 DeepSeek 的 Anthropic 兼容接口，并依赖若干私有扩展
 * （deepseek_web_search / deepseek_read_url 工具、safety_check、title、latest_reminder 角色、
 * Files API、语音接口）。第三方服务商（CommandCode、OpenAI 兼容中转、自建网关等）
 * 通常只实现标准协议，因此这里把「协议」与「能力」拆开：
 * - protocol 决定请求路径与报文格式（Anthropic Messages / OpenAI Chat Completions）；
 * - capabilities 决定是否发送 DeepSeek 私有字段，以及界面上哪些入口可用。
 */

/** 报文协议 */
export type ApiProtocol = 'anthropic' | 'openai'

/** 鉴权头：Anthropic 风格用 x-api-key，OpenAI 风格与多数中转用 Authorization: Bearer */
export type AuthMode = 'bearer' | 'x-api-key'

/** 深度思考参数的写法：DeepSeek 只认 type，官方 Anthropic 需要 budget_tokens */
export type ThinkingStyle = 'deepseek' | 'anthropic' | false

export type ProviderCapabilities = {
  /** 深度思考参数风格；false 表示不发送该字段 */
  thinking: ThinkingStyle
  /** 是否支持 deepseek_web_search / deepseek_read_url 服务端工具 */
  search: boolean
  /** 是否使用客户端联网搜索（第三方服务商没有服务端搜索，改为本地检索后注入上下文） */
  clientSearch: boolean
  /** 是否支持 Files API 上传附件 */
  files: boolean
  /** 是否支持服务端自动生成标题（title 字段） */
  title: boolean
  /** 是否支持 ASR / TTS 语音接口 */
  speech: boolean
  /** 是否支持 latest_reminder 扩展角色 */
  latestReminder: boolean
  /** 是否支持 safety_check 字段 */
  safetyCheck: boolean
}

export type ProviderConfig = {
  /** 预设 id；自定义服务商沿用预设 id（custom-anthropic / custom-openai） */
  id: string
  /** 展示名称 */
  name: string
  /** 接口根地址，含版本段，如 https://api.deepseek.com/anthropic/v1 */
  baseUrl: string
  protocol: ApiProtocol
  authMode: AuthMode
  /** 模型 id */
  model: string
  /** 需要 anthropic-version 头的服务商填版本号；null 表示不发送 */
  anthropicVersion: string | null
  capabilities: ProviderCapabilities
}

/** DeepSeek 官方：全部扩展能力可用 */
const DEEPSEEK_CAPABILITIES: ProviderCapabilities = {
  thinking: 'deepseek',
  search: true,
  clientSearch: false,
  files: true,
  title: true,
  speech: true,
  latestReminder: true,
  safetyCheck: true,
}

/** 第三方 Anthropic 兼容服务：标准 Messages 协议，无 DeepSeek 私有扩展 */
const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  thinking: 'anthropic',
  search: false,
  clientSearch: true,
  files: false,
  title: false,
  speech: false,
  latestReminder: false,
  safetyCheck: false,
}

/** OpenAI 兼容服务：Chat Completions 协议 */
const OPENAI_CAPABILITIES: ProviderCapabilities = {
  thinking: false,
  search: false,
  clientSearch: true,
  files: false,
  title: false,
  speech: false,
  latestReminder: false,
  safetyCheck: false,
}

export const PROVIDER_PRESETS: ProviderConfig[] = [
  {
    id: 'deepseek',
    name: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com/anthropic/v1',
    protocol: 'anthropic',
    authMode: 'x-api-key',
    model: 'deepseek-flash',
    anthropicVersion: null,
    capabilities: DEEPSEEK_CAPABILITIES,
  },
  {
    id: 'commandcode',
    name: 'CommandCode',
    baseUrl: 'https://api.commandcode.ai/v1',
    protocol: 'anthropic',
    authMode: 'bearer',
    model: 'claude-sonnet-5',
    // CommandCode 的 CORS 只放行 Content-Type / Authorization，不能带 anthropic-version
    anthropicVersion: null,
    capabilities: ANTHROPIC_CAPABILITIES,
  },
  {
    id: 'openai',
    name: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    protocol: 'openai',
    authMode: 'bearer',
    model: 'gpt-4o-mini',
    anthropicVersion: null,
    capabilities: OPENAI_CAPABILITIES,
  },
  {
    id: 'custom-anthropic',
    name: '自定义（Anthropic 兼容）',
    baseUrl: '',
    protocol: 'anthropic',
    authMode: 'bearer',
    model: '',
    anthropicVersion: '2023-06-01',
    capabilities: ANTHROPIC_CAPABILITIES,
  },
  {
    id: 'custom-openai',
    name: '自定义（OpenAI 兼容）',
    baseUrl: '',
    protocol: 'openai',
    authMode: 'bearer',
    model: '',
    anthropicVersion: null,
    capabilities: OPENAI_CAPABILITIES,
  },
]

export const DEFAULT_PROVIDER: ProviderConfig = PROVIDER_PRESETS[0]

export const getProviderPreset = (id: string): ProviderConfig | undefined =>
  PROVIDER_PRESETS.find((preset) => preset.id === id)

/** 去掉末尾斜杠；缺少协议时补 https:// */
export const normalizeBaseUrl = (value: string): string => {
  const trimmed = value.trim().replace(/\/+$/, '')
  if (!trimmed) {
    return ''
  }
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
}

/** 地址与模型都填了才算配置完成 */
export const isProviderConfigured = (provider: ProviderConfig): boolean =>
  provider.baseUrl.trim() !== '' && provider.model.trim() !== ''

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const readCapabilities = (
  value: unknown,
  fallback: ProviderCapabilities
): ProviderCapabilities => {
  if (!isRecord(value)) {
    return fallback
  }
  const thinking = value.thinking
  return {
    thinking:
      thinking === 'deepseek' || thinking === 'anthropic' || thinking === false
        ? thinking
        : fallback.thinking,
    search: typeof value.search === 'boolean' ? value.search : fallback.search,
    clientSearch: typeof value.clientSearch === 'boolean' ? value.clientSearch : fallback.clientSearch,
    files: typeof value.files === 'boolean' ? value.files : fallback.files,
    title: typeof value.title === 'boolean' ? value.title : fallback.title,
    speech: typeof value.speech === 'boolean' ? value.speech : fallback.speech,
    latestReminder:
      typeof value.latestReminder === 'boolean' ? value.latestReminder : fallback.latestReminder,
    safetyCheck: typeof value.safetyCheck === 'boolean' ? value.safetyCheck : fallback.safetyCheck,
  }
}

/**
 * 读取持久化的服务商配置：字段缺失或类型不对时回落到预设，
 * 能力开关以预设为准，避免旧数据把 DeepSeek 私有字段发给第三方。
 */
export const normalizeProvider = (value: unknown): ProviderConfig => {
  if (!isRecord(value)) {
    return DEFAULT_PROVIDER
  }
  const preset = getProviderPreset(String(value.id ?? '')) ?? DEFAULT_PROVIDER
  const protocol = value.protocol === 'openai' ? 'openai' : preset.protocol
  const authMode = value.authMode === 'x-api-key' ? 'x-api-key' : 'bearer'
  return {
    id: preset.id,
    name: typeof value.name === 'string' && value.name.trim() ? value.name : preset.name,
    baseUrl: normalizeBaseUrl(typeof value.baseUrl === 'string' ? value.baseUrl : preset.baseUrl),
    protocol,
    authMode,
    model: typeof value.model === 'string' ? value.model.trim() : preset.model,
    anthropicVersion:
      typeof value.anthropicVersion === 'string' && value.anthropicVersion.trim()
        ? value.anthropicVersion.trim()
        : null,
    capabilities: readCapabilities(value.capabilities, preset.capabilities),
  }
}

/** 切换预设时保留用户填过的地址与模型，只重置协议与能力 */
export const applyPreset = (current: ProviderConfig, presetId: string): ProviderConfig => {
  const preset = getProviderPreset(presetId)
  if (!preset) {
    return current
  }
  const keepEndpoint = current.id === preset.id
  return {
    ...preset,
    baseUrl: keepEndpoint ? current.baseUrl : preset.baseUrl,
    model: keepEndpoint ? current.model : preset.model,
    authMode: keepEndpoint ? current.authMode : preset.authMode,
    anthropicVersion: keepEndpoint ? current.anthropicVersion : preset.anthropicVersion,
  }
}
