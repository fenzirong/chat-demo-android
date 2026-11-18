import { ApiError } from './apiError.js'
import { readServerSentEvents } from './sse.js'
import type {
  CreateMessageRequest,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  StopReason,
} from './types.js'

/**
 * OpenAI Chat Completions 适配层。
 *
 * 第三方服务商（OpenAI 官方、各类中转、自建网关）大多只实现 OpenAI 协议，
 * 这里负责两件事：
 * 1. 把应用内部的 Anthropic 风格请求体转成 Chat Completions 请求；
 * 2. 把 `data: {...}` 的增量流翻译回内部的 MessageStreamEvent，
 *    这样上层的流式渲染、分支、续写逻辑完全不用改。
 */

type OpenAiContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type OpenAiMessage = {
  role: 'system' | 'user' | 'assistant'
  content: string | OpenAiContentPart[]
}

export type OpenAiChatRequest = {
  model: string
  messages: OpenAiMessage[]
  stream: true
  stream_options: { include_usage: true }
}

/** 只转换文本；附件走 Files API，OpenAI 协议下没有对应能力，直接跳过 */
const toOpenAiMessages = (messages: MessageParam[]): OpenAiMessage[] => {
  const result: OpenAiMessage[] = []
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      continue
    }
    if (message.role === 'user') {
      if (typeof message.content === 'string') {
        if (message.content) {
          result.push({ role: 'user', content: message.content })
        }
        continue
      }
      const text = message.content
        .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
        .map((block) => block.text)
        .join('\n\n')
      if (text) {
        result.push({ role: 'user', content: text })
      }
      continue
    }
    const text = message.content
      .filter((block): block is { type: 'text'; text: string } => block.type === 'text')
      .map((block) => block.text)
      .join('\n\n')
    if (text) {
      result.push({ role: 'assistant', content: text })
    }
  }
  return result
}

export const toOpenAiRequest = (body: CreateMessageRequest): OpenAiChatRequest => ({
  model: body.model,
  messages: [
    ...(body.system ? [{ role: 'system' as const, content: body.system }] : []),
    ...toOpenAiMessages(body.messages),
  ],
  stream: true,
  stream_options: { include_usage: true },
})

type OpenAiDelta = {
  role?: string
  content?: string | null
  /** DeepSeek / OpenRouter 等把思考内容放在这里 */
  reasoning_content?: string | null
  reasoning?: string | null
}

type OpenAiChunk = {
  id?: string
  model?: string
  choices?: {
    index?: number
    delta?: OpenAiDelta
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
  }
}

const STOP_REASONS: Record<string, StopReason> = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  content_filter: 'refusal',
}

const toUsage = (usage: OpenAiChunk['usage']): MessageUsage => ({
  input_tokens: usage?.prompt_tokens ?? 0,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: usage?.completion_tokens ?? 0,
})

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * 把 Chat Completions 的 SSE 流翻译成内部事件：
 * 首个增量前补 message_start，正文与思考各占一个内容块，收到 finish_reason 后收尾。
 */
export async function* readOpenAiStream(
  stream: ReadableStream<Uint8Array>,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  let started = false
  let nextIndex = 0
  let thinkingIndex: number | null = null
  let textIndex: number | null = null
  let finished = false
  let usage: MessageUsage | undefined

  const start = (id: string, model: string): MessageStreamEvent => {
    started = true
    return {
      type: 'message_start',
      message: { id, model, usage: toUsage(undefined) },
    }
  }

  const closeBlocks = function* (): Generator<MessageStreamEvent> {
    if (thinkingIndex !== null) {
      yield { type: 'content_block_stop', index: thinkingIndex }
      thinkingIndex = null
    }
    if (textIndex !== null) {
      yield { type: 'content_block_stop', index: textIndex }
      textIndex = null
    }
  }

  for await (const { data } of readServerSentEvents(stream, signal)) {
    if (data === '[DONE]') {
      break
    }
    let payload: unknown
    try {
      payload = JSON.parse(data)
    } catch {
      continue
    }
    if (!isRecord(payload)) {
      continue
    }
    if (isRecord(payload.error)) {
      const message = payload.error.message
      throw new ApiError('stream', typeof message === 'string' ? message : data)
    }
    const chunk = payload as OpenAiChunk
    if (!started) {
      yield start(chunk.id ?? '', chunk.model ?? '')
    }
    if (chunk.usage) {
      usage = toUsage(chunk.usage)
    }
    const choice = chunk.choices?.[0]
    if (!choice) {
      continue
    }
    const delta = choice.delta ?? {}
    const reasoning = delta.reasoning_content ?? delta.reasoning
    if (typeof reasoning === 'string' && reasoning) {
      if (thinkingIndex === null) {
        thinkingIndex = nextIndex++
        yield {
          type: 'content_block_start',
          index: thinkingIndex,
          content_block: { type: 'thinking', thinking: '', signature: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: thinkingIndex,
        delta: { type: 'thinking_delta', thinking: reasoning },
      }
    }
    if (typeof delta.content === 'string' && delta.content) {
      if (textIndex === null) {
        textIndex = nextIndex++
        yield {
          type: 'content_block_start',
          index: textIndex,
          content_block: { type: 'text', text: '' },
        }
      }
      yield {
        type: 'content_block_delta',
        index: textIndex,
        delta: { type: 'text_delta', text: delta.content },
      }
    }
    if (choice.finish_reason) {
      yield* closeBlocks()
      yield {
        type: 'message_delta',
        delta: {
          stop_reason: STOP_REASONS[choice.finish_reason] ?? 'end_turn',
          stop_sequence: null,
        },
        ...(usage ? { usage } : {}),
      }
      yield { type: 'message_stop' }
      finished = true
      return
    }
  }

  if (!finished) {
    // 没有 finish_reason 就断流：把已收到的内容收尾，再按中断上报
    yield* closeBlocks()
    throw new ApiError('interrupted', '')
  }
}
