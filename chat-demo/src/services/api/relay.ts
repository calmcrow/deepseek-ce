import type {
  ContentBlockDelta,
  MessageParam,
  MessageStreamEvent,
  MessageUsage,
  OutputBlockStart,
} from './types.js'

/**
 * 中转站 / 第三方模型适配：把 OpenAI 兼容的 /v1/chat/completions 流
 * 转成内部使用的 MessageStreamEvent，这样上层（store、气泡渲染）完全不用改。
 *
 * 约定：
 * - 请求体走 OpenAI 格式（messages / stream / stream_options）
 * - delta.content → 文本块，delta.reasoning_content → 思考块
 * - 不支持的细节（工具调用、标题、refusal）直接忽略
 */

type RelayMessagePart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

type RelayMessage = { role: 'system' | 'user' | 'assistant'; content: string | RelayMessagePart[] }

const isTextPart = (part: unknown): part is { type: string; text?: string } =>
  typeof part === 'object' && part !== null && 'type' in part

/** 内部消息块 → OpenAI 消息；图片只支持 URL 形式，本地附件在这里无法表达 */
const toRelayMessages = (system: string, messages: MessageParam[]): RelayMessage[] => {
  const result: RelayMessage[] = []
  if (system.trim()) {
    result.push({ role: 'system', content: system })
  }
  for (const message of messages) {
    if (message.role === 'latest_reminder') {
      // 提醒不是对话内容，折进最近一条用户消息里
      const last = result.at(-1)
      if (last && last.role === 'user') {
        last.content = `${typeof last.content === 'string' ? last.content : ''}\n\n${message.content}`
      }
      continue
    }
    if (typeof message.content === 'string') {
      result.push({ role: message.role, content: message.content })
      continue
    }
    const parts: RelayMessagePart[] = []
    for (const block of message.content) {
      if (message.role === 'user' && isTextPart(block)) {
        if (block.type === 'text' && typeof block.text === 'string') {
          parts.push({ type: 'text', text: block.text })
        }
        // image / document 块无法直接转成 OpenAI 形式（file_id 是 DeepSeek 私有的），跳过
        continue
      }
      if (typeof (block as { text?: string }).text === 'string') {
        parts.push({ type: 'text', text: (block as { text: string }).text })
      }
    }
    if (parts.length === 0) {
      continue
    }
    const onlyText = parts.every((part) => part.type === 'text')
    result.push({
      role: message.role,
      content: onlyText ? parts.map((part) => (part as { text: string }).text).join('') : parts,
    })
  }
  return result
}

/** 把用户填的地址规整成 .../v1/chat/completions */
export const relayEndpoint = (baseUrl: string): string => {
  const base = baseUrl.trim().replace(/\/+$/, '')
  if (!base) {
    return ''
  }
  if (base.endsWith('/chat/completions')) {
    return base
  }
  if (/\/v\d+$/.test(base)) {
    return `${base}/chat/completions`
  }
  return `${base}/v1/chat/completions`
}

type RelayToolDelta = { index: number; id?: string; function?: { name?: string; arguments?: string } }
type RelayChunk = {
  id?: string
  model?: string
  choices?: {
    delta?: { content?: string | null; reasoning_content?: string | null; tool_calls?: RelayToolDelta[] }
    finish_reason?: string | null
  }[]
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
}

const mapUsage = (usage: RelayChunk['usage']): MessageUsage | undefined =>
  usage
    ? {
        input_tokens: usage.prompt_tokens ?? 0,
        output_tokens: usage.completion_tokens ?? 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      }
    : undefined

export async function* streamRelayMessage({
  baseUrl,
  apiKey,
  model,
  system,
  messages,
  thinking,
  search,
  signal,
}: {
  baseUrl: string
  apiKey: string
  model: string
  system: string
  messages: MessageParam[]
  /** 深度思考：按 OpenAI 兼容惯例传 reasoning_effort，能否生效取决于该模型 */
  thinking?: boolean
  /** 联网搜索：传 web_search_options，支持内置搜索的模型才会真的联网 */
  search?: boolean
  signal: AbortSignal
}): AsyncGenerator<MessageStreamEvent> {
  const endpoint = relayEndpoint(baseUrl)
  if (!endpoint) {
    throw new Error('relayBaseUrl 为空')
  }
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      // Key 留空时不发 Authorization：公益中转站/公开中转常常不校验，
      // 而 `Bearer `（空 token）反而会被一部分网关直接判 401。
      ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model,
      messages: toRelayMessages(system, messages),
      stream: true,
      stream_options: { include_usage: true },
      // 这两个参数发给中转站，不认识的实现通常会忽略，不会报错
      ...(thinking ? { reasoning_effort: 'high' } : {}),
      ...(search ? { web_search_options: {} } : {}),
    }),
    signal,
  })
  if (!response.ok || !response.body) {
    const detail = await response.text().catch(() => '')
    throw new Error(
      `中转站返回 ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`
    )
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let started = false
  let textOpen = false
  let thinkingOpen = false
  let index = 0

  const openText = (): MessageStreamEvent => {
    textOpen = true
    const block: OutputBlockStart = { type: 'text', text: '' }
    return { type: 'content_block_start', index, content_block: block }
  }
  const openThinking = (): MessageStreamEvent => {
    thinkingOpen = true
    const block: OutputBlockStart = { type: 'thinking', thinking: '', signature: '' }
    return { type: 'content_block_start', index, content_block: block }
  }

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) {
        break
      }
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const raw of lines) {
        const line = raw.trim()
        if (!line.startsWith('data:')) {
          continue
        }
        const payload = line.slice(5).trim()
        if (!payload || payload === '[DONE]') {
          continue
        }
        let chunk: RelayChunk
        try {
          chunk = JSON.parse(payload) as RelayChunk
        } catch {
          continue
        }
        if (!started) {
          started = true
          yield {
            type: 'message_start',
            message: { id: chunk.id ?? 'relay', model: chunk.model ?? model },
          }
        }
        const delta = chunk.choices?.[0]?.delta
        if (delta?.reasoning_content) {
          if (!thinkingOpen) {
            index = thinkingOpen || textOpen ? index + 1 : 0
            yield openThinking()
          }
          const blockDelta: ContentBlockDelta = {
            type: 'thinking_delta',
            thinking: delta.reasoning_content,
          }
          yield { type: 'content_block_delta', index, delta: blockDelta }
        }
        if (delta?.content) {
          if (thinkingOpen) {
            yield { type: 'content_block_stop', index }
            thinkingOpen = false
            index += 1
          }
          if (!textOpen) {
            yield openText()
          }
          const blockDelta: ContentBlockDelta = { type: 'text_delta', text: delta.content }
          yield { type: 'content_block_delta', index, delta: blockDelta }
        }
        const finish = chunk.choices?.[0]?.finish_reason
        if (finish) {
          if (thinkingOpen) {
            yield { type: 'content_block_stop', index }
            thinkingOpen = false
          }
          if (textOpen) {
            yield { type: 'content_block_stop', index }
            textOpen = false
          }
          yield {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn', stop_sequence: null },
            usage: mapUsage(chunk.usage),
          }
        }
      }
    }
    yield { type: 'message_stop' }
  } finally {
    reader.releaseLock()
  }
}
