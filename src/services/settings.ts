import { create } from 'zustand'
import type { TtsVoice } from './api/speech.js'
import { normalizeLocation, type UserLocation } from './location.js'
import { DEFAULT_PROVIDER, normalizeProvider, type ProviderConfig } from './providers.js'

export type Locale = 'zh-CN' | 'en-US'

/** 主题偏好；默认跟随系统 */
export type ThemePreference = 'light' | 'dark' | 'system'

/**
 * 本机设置，存 localStorage：API 服务商与 Key、语言、主题、位置、朗读音色、
 * 深度思考与智能搜索开关、侧边栏收起状态
 */
type Settings = {
  /** 当前服务商的 API Key，随服务商切换 */
  apiKey: string | null
  /** 按服务商 id 分别保存的 Key，切换服务商不会互相覆盖 */
  apiKeys: Record<string, string>
  provider: ProviderConfig
  locale: Locale
  themePreference: ThemePreference
  location: UserLocation | null
  ttsVoice: TtsVoice
  thinking: boolean
  search: boolean
  siderCollapsed: boolean
}

const KEYS = {
  apiKey: 'chat-demo:api-key',
  apiKeys: 'chat-demo:api-keys',
  provider: 'chat-demo:provider',
  locale: 'chat-demo:locale',
  location: 'chat-demo:location',
  themePreference: 'chat-demo:theme-preference',
  ttsVoice: 'chat-demo:tts-voice',
  thinking: 'chat-demo:thinking',
  search: 'chat-demo:search',
  siderCollapsed: 'chat-demo:sider-collapsed',
} as const

const read = (key: string) => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string | null) => {
  try {
    if (value === null) {
      localStorage.removeItem(key)
    } else {
      localStorage.setItem(key, value)
    }
  } catch {
    // 存储不可用时只在内存中生效
  }
}

/** 位置选择模式跟随浏览器语言，与应用内选择的界面语言无关。 */
export const isChineseBrowser = (): boolean =>
  (typeof navigator === 'undefined' ? 'zh' : navigator.language).toLowerCase().startsWith('zh')

const initialLocale = (): Locale => {
  const saved = read(KEYS.locale)
  if (saved === 'zh-CN' || saved === 'en-US') {
    return saved
  }
  return isChineseBrowser() ? 'zh-CN' : 'en-US'
}

const initialLocation = (): UserLocation | null => {
  try {
    const location = normalizeLocation(JSON.parse(read(KEYS.location) ?? 'null'))
    if (!location) {
      return null
    }
    return isChineseBrowser()
      ? location.region === 'CN' && location.province
        ? location
        : null
      : { region: location.region }
  } catch {
    return null
  }
}

/** 未保存过时跟随系统 */
const initialThemePreference = (): ThemePreference => {
  const saved = read(KEYS.themePreference)
  return saved === 'light' || saved === 'dark' ? saved : 'system'
}

/** 未保存过时使用服务端默认音色 stella（海星） */
const initialTtsVoice = (): TtsVoice => (read(KEYS.ttsVoice) === 'tide' ? 'tide' : 'stella')

const initialProvider = (): ProviderConfig => {
  try {
    return normalizeProvider(JSON.parse(read(KEYS.provider) ?? 'null'))
  } catch {
    return DEFAULT_PROVIDER
  }
}

/** 按服务商保存的 Key；旧版本只有单个 Key，迁移到 DeepSeek 名下 */
const initialApiKeys = (): Record<string, string> => {
  const keys: Record<string, string> = {}
  try {
    const saved: unknown = JSON.parse(read(KEYS.apiKeys) ?? 'null')
    if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
      for (const [id, value] of Object.entries(saved)) {
        if (typeof value === 'string' && value) {
          keys[id] = value
        }
      }
    }
  } catch {
    // 解析失败按空处理
  }
  const legacy = read(KEYS.apiKey)
  if (legacy && !keys[DEFAULT_PROVIDER.id]) {
    keys[DEFAULT_PROVIDER.id] = legacy
  }
  return keys
}

const initialProviderState = () => {
  const provider = initialProvider()
  const apiKeys = initialApiKeys()
  return { provider, apiKeys, apiKey: apiKeys[provider.id] ?? null }
}

const providerState = initialProviderState()

export const useSettings = create<Settings>(() => ({
  ...providerState,
  locale: initialLocale(),
  location: initialLocation(),
  themePreference: initialThemePreference(),
  ttsVoice: initialTtsVoice(),
  thinking: read(KEYS.thinking) === 'true',
  search: read(KEYS.search) === 'true',
  siderCollapsed: read(KEYS.siderCollapsed) === 'true',
}))

export const setLocale = (locale: Locale) => {
  write(KEYS.locale, locale)
  useSettings.setState({ locale })
}

export const setLocation = (value: UserLocation | null) => {
  const location = normalizeLocation(value)
  write(KEYS.location, location ? JSON.stringify(location) : null)
  useSettings.setState({ location })
}

export const setThemePreference = (themePreference: ThemePreference) => {
  write(KEYS.themePreference, themePreference)
  useSettings.setState({ themePreference })
}

export const setTtsVoice = (ttsVoice: TtsVoice) => {
  write(KEYS.ttsVoice, ttsVoice)
  useSettings.setState({ ttsVoice })
}

export const setApiKey = (apiKey: string | null) => {
  const { provider, apiKeys } = useSettings.getState()
  const next: Record<string, string> = {}
  for (const [id, value] of Object.entries(apiKeys)) {
    if (id !== provider.id) {
      next[id] = value
    }
  }
  if (apiKey) {
    next[provider.id] = apiKey
  }
  write(KEYS.apiKeys, JSON.stringify(next))
  write(KEYS.apiKey, null)
  useSettings.setState({ apiKeys: next, apiKey })
}

/** 切换服务商：Key 跟着服务商走，未保存过时为空 */
export const setProvider = (provider: ProviderConfig) => {
  write(KEYS.provider, JSON.stringify(provider))
  useSettings.setState({
    provider,
    apiKey: useSettings.getState().apiKeys[provider.id] ?? null,
  })
}

export const setThinking = (thinking: boolean) => {
  write(KEYS.thinking, String(thinking))
  useSettings.setState({ thinking })
}

export const setSearch = (search: boolean) => {
  write(KEYS.search, String(search))
  useSettings.setState({ search })
}

export const setSiderCollapsed = (siderCollapsed: boolean) => {
  write(KEYS.siderCollapsed, String(siderCollapsed))
  useSettings.setState({ siderCollapsed })
}
