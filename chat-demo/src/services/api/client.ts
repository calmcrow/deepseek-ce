import { translate, type TranslationMessage } from '../../i18n/index.js'
import { readMessageEvent } from './parseEvent.js'
import { readServerSentEvents } from './sse.js'
import type {
  ApiErrorBody,
  ChatModel,
  CreateMessageRequest,
  FileObject,
  FilePurpose,
  MessageStreamEvent,
  ModelInfo,
} from './types.js'

/** 构建期 API 地址，默认 https://api.deepseek.com；本地开发支持开发服务器代理 */
export const API_ORIGIN = __API_ORIGIN__
/** Anthropic 兼容接口的前缀 */
const ANTHROPIC_BASE_URL = `${API_ORIGIN}/anthropic/v1`
/** 引用 Files API 上传的图片、调用 Anthropic 兼容 Files API 时必须携带 */
const FILES_BETA = 'files-api-2025-04-14'

export type ApiErrorKind =
  /** 非 2xx 响应 */
  | 'http'
  /** 流中返回的错误帧（如等待生成超时），随后连接关闭 */
  | 'stream'
  /** 请求没有到达服务端（断网、跨域被拦截等） */
  | 'network'
  /** 流在 message_stop 之前结束 */
  | 'interrupted'
  /** 响应不符合协议（如非 SSE 响应） */
  | 'protocol'

export class ApiError extends Error {
  readonly localMessage?: TranslationMessage

  constructor(
    readonly kind: ApiErrorKind,
    message: string | TranslationMessage,
    readonly status?: number
  ) {
    super(typeof message === 'string' ? message : translate(message.key, message.params))
    this.name = 'ApiError'
    this.localMessage = typeof message === 'string' ? undefined : message
  }
}

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

const anthropicHeaders = (apiKey: string, beta: boolean): Record<string, string> => ({
  // DeepSeek 兼容接口的鉴权方式，也可使用 Authorization: Bearer。
  'x-api-key': apiKey,
  // Files API 和通过 file_id 引用图片时必传；纯文本聊天无需携带。
  ...(beta ? { 'anthropic-beta': FILES_BETA } : {}),
})

/** 用 GET /models 校验 API Key（不产生费用） */
export const verifyApiKey = async (apiKey: string, signal?: AbortSignal): Promise<void> => {
  await request(`${API_ORIGIN}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
}

/** 正整数字段（token 数）；接口没给、类型不对或不是正数时返回 undefined */
const toTokenCount = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined

/**
 * 单个模型条目；官方返回的字段比这里用到的多（模态、推理档位等），
 * 这里取选择器要的 id 与展示名，外加上下文窗口 `context_window` 和单次输出上限
 * `max_output_tokens`（上下文用量条的分母靠它们），其余忽略；兼容 id 直接是字符串的写法。
 */
const toModelInfo = (value: unknown): ModelInfo | null => {
  if (typeof value === 'string') {
    const id = value.trim()
    return id ? { id } : null
  }
  if (typeof value !== 'object' || value === null) {
    return null
  }
  const { id, name, context_window, max_output_tokens } = value as {
    id?: unknown
    name?: unknown
    context_window?: unknown
    max_output_tokens?: unknown
  }
  if (typeof id !== 'string' || !id.trim()) {
    return null
  }
  const modelId = id.trim()
  const displayName = typeof name === 'string' ? name.trim() : ''
  const contextWindow = toTokenCount(context_window)
  const maxOutputTokens = toTokenCount(max_output_tokens)
  return {
    id: modelId,
    ...(displayName ? { name: displayName } : {}),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
  }
}

/** GET /models：列出当前 API Key 可用的模型，用于「刷新模型列表」 */
export const listModels = async (
  apiKey: string,
  signal?: AbortSignal
): Promise<ModelInfo[]> => {
  const response = await request(`${API_ORIGIN}/models`, {
    method: 'GET',
    headers: { Authorization: `Bearer ${apiKey}` },
    signal,
  })
  const body = (await response.json().catch(() => null)) as { data?: unknown } | null
  const items = Array.isArray(body?.data) ? body.data : []
  const models: ModelInfo[] = []
  const seen = new Set<string>()
  for (const item of items) {
    const model = toModelInfo(item)
    if (model && !seen.has(model.id)) {
      seen.add(model.id)
      models.push(model)
    }
  }
  return models
}

/**
 * POST /anthropic/v1/files 上传附件（不设过期时间，会话里的历史附件一直可用）。
 * purpose 为 null 时不传该字段（图片）；purpose 必须排在 file 之前。
 */
export const uploadFile = async (
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
  const response = await request(`${ANTHROPIC_BASE_URL}/files`, {
    method: 'POST',
    headers: anthropicHeaders(apiKey, true),
    body: form,
    signal,
  })
  return (await response.json()) as FileObject
}

/** DELETE /anthropic/v1/files/{file_id} */
export const deleteFile = async (apiKey: string, fileId: string): Promise<void> => {
  await request(`${ANTHROPIC_BASE_URL}/files/${encodeURIComponent(fileId)}`, {
    method: 'DELETE',
    headers: anthropicHeaders(apiKey, true),
  })
}

const hasFile = (body: CreateMessageRequest) =>
  body.messages.some(
    (message) =>
      typeof message.content !== 'string' &&
      message.content.some((block) => block.type === 'image' || block.type === 'document')
  )

/** 标题请求的系统提示词：一行纯文本、跟随消息语言、长度可控 */
const TITLE_SYSTEM_PROMPT = [
  'Create a concise title for this conversation from the user message.',
  'Name only the topic; do not include conclusions, answers, or any details from the conversation.',
  'Return only the title on one line, in plain text, with no quotes, prefix, explanation, Markdown, or code.',
  'Use the language of the message.',
  'Keep it short: at most 20 CJK characters or 6 words.',
  'If the message gives little to name, still return a short best-effort title.',
].join('\n')

/** 标题只看提问的开头一段；标题是独立请求，不需要读完整对话 */
const TITLE_INPUT_LIMIT = 2000

/** 从非流式响应里取出第一个非空行的文字块，作为标题 */
const titleFromResponse = (body: unknown): string | null => {
  if (typeof body !== 'object' || body === null || !('content' in body)) {
    return null
  }
  const blocks = (body as { content: unknown }).content
  if (!Array.isArray(blocks)) {
    return null
  }
  const text = blocks
    .map((block) => {
      if (typeof block !== 'object' || block === null) {
        return ''
      }
      const { type, text: value } = block as { type?: unknown; text?: unknown }
      return type === 'text' && typeof value === 'string' ? value : ''
    })
    .join(' ')
  const line = text
    .split(/\r?\n/)
    .map((item) => item.trim())
    .find((item) => item.length > 0)
  if (!line) {
    return null
  }
  // 模型偶尔会加引号或星号，去掉包裹后再截断
  const clean = line.replace(/^["'“”‘’*]+|["'“”‘’*]+$/g, '').slice(0, 60)
  return clean || null
}

/**
 * 独立生成会话标题：与主请求分开，只带用户文字，不受主请求输入预算的限制。
 * 失败返回 null，由调用方保留本地兜底标题（与官方「标题自行兜底」的建议一致）。
 */
export const generateTitle = async (
  apiKey: string,
  model: ChatModel,
  text: string,
  signal?: AbortSignal
): Promise<string | null> => {
  const input = text.trim().slice(0, TITLE_INPUT_LIMIT)
  if (!input) {
    return null
  }
  const response = await request(`${ANTHROPIC_BASE_URL}/messages`, {
    method: 'POST',
    headers: { ...anthropicHeaders(apiKey, false), 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      system: TITLE_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: input }],
      max_tokens: 64,
      thinking: { type: 'disabled' },
    }),
    signal,
  })
  return titleFromResponse(await response.json())
}

/**
 * POST /anthropic/v1/messages（stream: true），逐个产出流式事件，收到 message_stop 时结束。
 * ping、保活注释与无法解析的内容不产出；中止请求时抛出 signal 的 AbortError。
 */
export async function* streamMessage(
  apiKey: string,
  body: CreateMessageRequest,
  signal: AbortSignal
): AsyncGenerator<MessageStreamEvent> {
  const response = await request(`${ANTHROPIC_BASE_URL}/messages`, {
    method: 'POST',
    headers: {
      ...anthropicHeaders(apiKey, hasFile(body)),
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    },
    body: JSON.stringify({ ...body, stream: true }),
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
