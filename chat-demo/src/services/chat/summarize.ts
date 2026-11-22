import { streamMessage } from '../api/client.js'
import type { ChatModel, MessageParam } from '../api/types.js'
import { formatSize } from '../attachments.js'
import { getReplyText } from './reply.js'
import type { AssistantMessage, FileAttachment, UserMessage } from './types.js'

/** 送去摘要的正文上限，超出时保留头尾各一半，避免一次摘要就烧掉巨额额度 */
const DIGEST_MAX_CHARS = 150_000
/** 附件行里带上本轮提问的开头，让摘要知道这个附件是干什么用的 */
const MAX_QUESTION_HINT = 200
/** 每条回复最多保留几条搜索来源 / 阅读网页线索 */
const MAX_SEARCH_SOURCES = 5
const MAX_FETCH_LINKS = 3
/** 二次压缩时回看旧轮次：每轮只取提问与回答的开头 */
const ARCHIVE_HINT_CHARS = 200
/** 回看片段的总上限，避免为了压缩又塞进一大堆原文 */
const ARCHIVE_MAX_CHARS = 30_000

const SUMMARY_PROMPT = `你在为一段长对话写「前情提要」，供之后继续对话时参考。把下面的旧对话压缩成一份结构化清单，要求另一个模型读完就能无缝接着聊。

严格按下面的 Markdown 结构输出：小节标题和顺序都不要改；某一节没有内容就写「（无）」，不要省略整节。用简练的条目，不要写成段落。

## 用户目标与要求
- [最初和后来的目标；措辞重要时保留原话]

## 关键事实与数据
- [结论、数字、日期、人名、专有名词、引用的原话；涉及技术内容时保留路径、命令、报错原文]

## 已达成的结论
- [确定下来的方案或判断，以及理由]

## 未解决的问题
- [还没完成或待确认的事]

## 当前进展
- [截断时正在做什么]

## 下一步
- [紧接着要做的一件事，或「（无）」]

## 关键上下文
- [用户的偏好、约定、约束和待补信息]

规则：
- 用对话本身的语言写。
- 精确保留数字、日期、人名、专有名词和引号里的原话；涉及技术内容时同样保留路径、命令、报错原文、标识符，不要改写或概括。
- 附件（图片、文档）的内容以对话里已有的描述和结论为准，不要凭空补充或编造。
- 忠实记录用户的纠正和明确要求。
- 不要提到这次摘要请求，也不要提到上下文被压缩过。
- 如果旧对话里已有「前情提要」，它是上一轮的检查点：保留仍然成立的事实，丢掉已过时的，与新信息合并成一份，不要照抄。
- 如果输入里还附了「更早对话的关键片段」，用它核对并补全旧摘要里的遗漏，但同样不要照抄。
- 总长度控制在 2000 字以内。`

/** 重放模式追加的最后一条用户消息；放在这里而不是 system，才能复用原请求的缓存前缀 */
const COMPACTION_INSTRUCTION = `请把上面的对话压缩成一份「前情提要」，供之后继续对话时参考。要求另一个模型读完就能无缝接着聊。

严格按下面的 Markdown 结构输出：小节标题和顺序都不要改；某一节没有内容就写「（无）」，不要省略整节。用简练的条目，不要写成段落。

## 用户目标与要求
- [最初和后来的目标；措辞重要时保留原话]

## 关键事实与数据
- [结论、数字、日期、人名、专有名词、引用的原话；涉及技术内容时保留路径、命令、报错原文]

## 已达成的结论
- [确定下来的方案或判断，以及理由]

## 未解决的问题
- [还没完成或待确认的事]

## 当前进展
- [截断时正在做什么]

## 下一步
- [紧接着要做的一件事，或「（无）」]

## 关键上下文
- [用户的偏好、约定、约束和待补信息]

规则：
- 用对话本身的语言写。
- 精确保留数字、日期、人名、专有名词和引号里的原话；涉及技术内容时同样保留路径、命令、报错原文、标识符，不要改写或概括。
- 附件（图片、文档）的内容以对话里已有的描述和结论为准，不要凭空补充或编造。
- 忠实记录用户的纠正和明确要求。
- 不要提到这次摘要请求，也不要提到上下文被压缩过。
- 如果旧对话里已有「前情提要」，它是上一轮的检查点：保留仍然成立的事实，丢掉已过时的，与新信息合并成一份，不要照抄。
- 总长度控制在 2000 字以内。`

/** 超过上限时保留头尾，中间标明省略了多少字 */
const clip = (text: string, limit: number): string => {
  if (text.length <= limit) {
    return text
  }
  const half = Math.floor(limit / 2)
  return `${text.slice(0, half)}\n……（中间省略 ${text.length - limit} 字）……\n${text.slice(-half)}`
}

/**
 * 附件线索：名字、类型、大小，外加本轮提问的开头。
 * 不额外调模型去读图片或 PDF——那一轮的问答里已经写了它们的用途和结论，
 * 摘要模型要做的只是从对话文字里把相关描述带过去。
 */
const describeFiles = (files: FileAttachment[], question: string): string[] => {
  const hint = clip(question.trim(), MAX_QUESTION_HINT)
  return files.map((file) => {
    const kind = file.isImage ? '图片' : '文件'
    const head = `[${kind}] ${file.name}（${formatSize(file.size)}）`
    return hint ? `${head}，本轮提问：${hint}` : head
  })
}

/**
 * 二次压缩时回看已压缩过的轮次：每轮只留提问和回答的开头，
 * 让模型能核对旧摘要、补上遗漏，而不是只对着上一版摘要继续浓缩。
 */
const describeArchive = (rounds: [UserMessage, AssistantMessage][]): string => {
  const lines = rounds.map(([user, reply]) => {
    const question = clip(user.content.trim(), ARCHIVE_HINT_CHARS)
    const answer = clip(getReplyText(reply).trim(), ARCHIVE_HINT_CHARS)
    return `- 问：${question}\n  答：${answer}`
  })
  return clip(lines.join('\n'), ARCHIVE_MAX_CHARS)
}

/**
 * 工具结果只留可回溯的线索：搜索来源和读过的网页，不保留正文。
 * 和官方 DSH 的「工具结果修剪」同一思路，但这里更省——只留 URL 和标题。
 */
const describeToolResults = (reply: AssistantMessage): string[] => {
  const lines: string[] = []
  let searches = 0
  let fetches = 0
  for (const block of reply.blocks) {
    if (block.type === 'web_search_tool_result') {
      for (const item of block.content) {
        if (searches >= MAX_SEARCH_SOURCES || !('title' in item) || !item.url) {
          continue
        }
        lines.push(`- 搜索来源：${item.title}（${item.url}）`)
        searches += 1
      }
    } else if (block.type === 'web_fetch_tool_result') {
      if (fetches >= MAX_FETCH_LINKS || block.content.type !== 'web_fetch_result') {
        continue
      }
      const { url, content } = block.content
      if (!url) {
        continue
      }
      lines.push(`- 阅读网页：${content.title ?? url}（${url}）`)
      fetches += 1
    }
  }
  return lines
}

/**
 * 把要被裁掉的若干轮对话拼成纯文本，供摘要使用。
 * 附件不随原文一起丢：保留名字、大小和当轮提问；工具结果保留网址；
 * 正文整条保留，不按轮次裁剪（由总上限兜底）。
 * 二次压缩时传入 archive，让模型能回头看已经压过的原文片段。
 */
export const buildDigest = (
  rounds: [UserMessage, AssistantMessage][],
  archive?: [UserMessage, AssistantMessage][]
): string => {
  const parts: string[] = []
  if (archive && archive.length > 0) {
    parts.push(`【更早对话的关键片段，供核对旧摘要、补全遗漏，不要照抄】\n${describeArchive(archive)}`)
  }
  for (const [user, reply] of rounds) {
    const question = user.content.trim()
    const files = describeFiles(user.files, user.content)
    if (question || files.length > 0) {
      const lines = [question, ...(files.length > 0 ? ['附件：', ...files] : [])]
      parts.push(`用户：\n${lines.filter(Boolean).join('\n')}`)
    }
    const answer = getReplyText(reply).trim()
    const tools = describeToolResults(reply)
    if (answer || tools.length > 0) {
      const lines = [answer, ...(tools.length > 0 ? ['工具结果：', ...tools] : [])]
      parts.push(`助手：\n${lines.filter(Boolean).join('\n')}`)
    }
  }
  const digest = parts.join('\n\n')
  if (digest.length <= DIGEST_MAX_CHARS) {
    return digest
  }
  const half = Math.floor(DIGEST_MAX_CHARS / 2)
  return `${digest.slice(0, half)}\n\n……（中间省略）……\n\n${digest.slice(-half)}`
}

/**
 * 调一次模型，把 digest 写成要点清单。
 * 失败（额度、网络、401 等）抛错，由调用方决定是退回「只压缩、不要提要」还是整体失败。
 */
export const summarizeDigest = async ({
  apiKey,
  model,
  digest,
  signal,
}: {
  apiKey: string
  model: ChatModel
  digest: string
  signal: AbortSignal
}): Promise<string> => {
  if (!digest.trim()) {
    return ''
  }
  let text = ''
  const stream = streamMessage(
    apiKey,
    {
      model,
      system: SUMMARY_PROMPT,
      messages: [{ role: 'user', content: `【旧对话】\n${digest}` }],
      thinking: { type: 'disabled' },
      tools: [],
    },
    signal
  )
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    }
  }
  return text.trim()
}

/**
 * 摘要（重放模式）：把被遮蔽的轮次按原始请求消息重放，末尾追加一条压缩指令。
 * 模型看到的是真实对话结构（含工具结果块），比拼接纯文本更完整。
 */
export const summarizeMessages = async ({
  apiKey,
  model,
  system,
  messages,
  signal,
}: {
  apiKey: string
  model: ChatModel
  /** 会话自己的系统提示词；复用它能命中上下文缓存的前缀 */
  system: string
  messages: MessageParam[]
  signal: AbortSignal
}): Promise<string> => {
  if (messages.length === 0) {
    return ''
  }
  let text = ''
  const stream = streamMessage(
    apiKey,
    {
      model,
      system,
      messages: [...messages, { role: 'user', content: COMPACTION_INSTRUCTION }],
      thinking: { type: 'disabled' },
      tools: [],
    },
    signal
  )
  for await (const event of stream) {
    if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
      text += event.delta.text
    }
  }
  return text.trim()
}
