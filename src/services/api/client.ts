import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import { ApiError, type ApiErrorKind } from './apiError.js'
import { readOpenAiStream, toOpenAiRequest } from './openai.js'
import type {
  ApiErrorBody,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
} from './types.js'
import type { ProviderConfig } from '../providers.js'

export { ApiError }
export type { ApiErrorKind }

/** 构建期 API 地址，默认 https://api.deepseek.com；语音接口与 DeepSeek 官方服务商使用 */
export const API_ORIGIN = __API_ORIGIN__
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'
/** 第三方 Anthropic 兼容接口的输出上限；官方协议要求 max_tokens 必填 */
const ANTHROPIC_MAX_TOKENS = 8192
/** 扩展思考的预算，必须小于 max_tokens */
const ANTHROPIC_THINKING_BUDGET = 4096

const isErrorBody = (value: unknown): value is ApiErrorBody =>
  typeof value === 'object' &&
  value !== null &&
  'error' in value &&
  typeof (value as ApiErrorBody).error?.message === 'string'

const readErrorResponse = async (
  response: Response,
  kind: 'http' | 'protocol' = 'http',
  fallback = response.statusText
): Promise<ApiError> => {
  const text = await response.text().catch(() => '')
  let message = text || fallback
  try {
    const body: unknown = JSON.parse(text)
    if (isErrorBody(body)) {
      message = body.error.message
    }
  } catch {
    // 非 JSON 响应体直接展示原文
  }
  return new ApiError(kind, message, response.status)
}

export const request = async (url: string, init: RequestInit): Promise<Response> => {
  let response: Response
  try {
    response = await fetch(url, init)
  } catch (error) {
    if (init.signal?.aborted) {
      throw error
    }
    throw new ApiError('network', error instanceof Error ? error.message : String(error))
  }
  if (!response.ok) {
    throw await readErrorResponse(response)
  }
  return response
}

/**
 * 鉴权头：Anthropic 风格用 x-api-key，OpenAI 风格与多数中转用 Bearer。
 * anthropic-version 只在服务商显式配置时发送——部分中转的 CORS 白名单里没有这个头，
 * 多带一个头会让预检直接失败。
 */
const authHeaders = (provider: ProviderConfig, apiKey: string): Record<string, string> => {
  const headers: Record<string, string> =
    provider.protocol === 'openai' || provider.authMode === 'bearer'
      ? { Authorization: `Bearer ${apiKey}` }
      : { 'x-api-key': apiKey }
  if (provider.anthropicVersion) {
    headers['anthropic-version'] = provider.anthropicVersion
  }
  return headers
}

/**
 * 模型列表地址：DeepSeek 的 /models 在根路径，不在 /anthropic/v1 下；
 * 其余服务商按 OpenAI / Anthropic 惯例挂在 baseUrl 之后。
 */
const modelsUrl = (provider: ProviderConfig): string =>
  provider.id === 'deepseek'
    ? new URL('/models', provider.baseUrl).toString()
    : `${provider.baseUrl}/models`

/** 部分服务商没有 GET /models，用一个最小请求确认 Key 可用 */
const probeProvider = async (
  provider: ProviderConfig,
  apiKey: string,
  signal?: AbortSignal
): Promise<void> => {
  const headers = { ...authHeaders(provider, apiKey), 'Content-Type': 'application/json' }
  const body =
    provider.protocol === 'openai'
      ? { model: provider.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
      : { model: provider.model, max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] }
  const path = provider.protocol === 'openai' ? '/chat/completions' : '/messages'
  await request(`${provider.baseUrl}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })
}

/** 校验 API Key：优先用 GET /models（不产生费用），服务商不支持时退回最小请求 */
export const verifyApiKey = async (
  provider: ProviderConfig,
  apiKey: string,
  signal?: AbortSignal
): Promise<void> => {
  try {
    await request(modelsUrl(provider), {
      method: 'GET',
      headers: authHeaders(provider, apiKey),
      signal,
    })
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 405)) {
      await probeProvider(provider, apiKey, signal)
      return
    }
    throw error
  }
}

/**
 * POST {baseUrl}/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
  provider: ProviderConfig,
  apiKey: string,
  file: File,
  purpose: FilePurpose | null,
  signal?: AbortSignal
): Promise<FileObject> => {
  const form = new FormData()
  if (purpose) {
    form.append('purpose', purpose)
  }
  form.append('file', file)
  const response = await request(`${provider.baseUrl}/files`, {
    method: 'POST',
    headers: { ...authHeaders(provider, apiKey), 'anthropic-beta': FILES_BETA },
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE {baseUrl}/files/{file_id} */
export const deleteFile = async (
  provider: ProviderConfig,
  apiKey: string,
  fileId: string
): Promise<void> => {
  await request(`${provider.baseUrl}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: { ...authHeaders(provider, apiKey), 'anthropic-beta': FILES_BETA },
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/**
 * 发起流式生成，逐个产出内部事件，收到 message_stop 时结束。
 * Anthropic 兼容服务商走 Messages 协议；OpenAI 兼容服务商由 openai.ts 翻译成同样的事件。
 */
export async function* streamMessage(
  provider: ProviderConfig,
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  if (provider.protocol === 'openai') {
    const response = await request(`${provider.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        ...authHeaders(provider, apiKey),
        'Content-Type': 'application/json',
        Accept: 'text/event-stream',
      },
      body: JSON.stringify(toOpenAiRequest(body)),
      signal,
    })
    const contentType = response.headers.get('Content-Type') ?? ''
    if (!response.body || !contentType.includes('text/event-stream')) {
      throw await readErrorResponse(response, 'protocol', '')
    }
    yield* readOpenAiStream(response.body, signal)
    return
  }

  // 官方 Anthropic 协议的 thinking 参数与 DeepSeek 不同：需要 budget_tokens，且 max_tokens 必填
  const wire: Record<string, unknown> = { ...body, stream: true }
  if (provider.capabilities.thinking === 'anthropic') {
    if (body.thinking?.type === 'enabled') {
      wire.thinking = { type: 'enabled', budget_tokens: ANTHROPIC_THINKING_BUDGET }
    } else {
      delete wire.thinking
    }
    wire.max_tokens = Math.max(
      typeof body.max_tokens === 'number' ? body.max_tokens : ANTHROPIC_MAX_TOKENS,
      ANTHROPIC_THINKING_BUDGET * 2
    )
  }
  const response = await request(`${provider.baseUrl}/messages`, {
    method: 'POST',
    headers: {
      ...authHeaders(provider, apiKey),
      ...(provider.capabilities.files && hasFile(body) ? { 'anthropic-beta': FILES_BETA } : {}),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify(wire),
    signal,
  })
  const contentType = response.headers.get('Content-Type') ?? ''
  if (!response.body || !contentType.includes('text/event-stream')) {
    throw await readErrorResponse(response, 'protocol', '')
  }
  for await (const { event: eventName, data } of readServerSentEvents(response.body, signal)) {
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      if (eventName !== 'error') {
        continue
      }
    }
    if (isErrorBody(payload)) {
      throw new ApiError('stream', payload.error.message)
    }
    if (eventName === 'error') {
      throw new ApiError('stream', data)
    }
    const event = readMessageEvent(payload)
    if (!event) {
      continue
    }
    yield event
    if (event.type === 'message_stop') {
      return
    }
  }
  // 服务端没有提供错误内容时保持为空，不推测断流原因。
  throw new ApiError('interrupted', '')
}
