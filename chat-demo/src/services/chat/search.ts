import { loadAllSessions } from './db.js'
import { toSessionSummary, type Message, type Session, type SessionSummary } from './types.js'

/** 命中结果：会话摘要 + 该条命中消息的片段、id 与时间 */
export type SessionSearchHit = SessionSummary & {
  snippet?: string
  messageId?: string
  /** 命中消息的时间，用于排序；标题命中取会话更新时间 */
  hitAt?: number
}

/** 会话列表缓存：搜索会反复读同一批会话，短时间内复用，避免每次全量读 IndexedDB */
let sessionCache: { at: number; sessions: Session[] } | null = null
const SESSION_CACHE_TTL = 30_000

const loadSessions = async (): Promise<Session[]> => {
  if (sessionCache && Date.now() - sessionCache.at < SESSION_CACHE_TTL) {
    return sessionCache.sessions
  }
  const sessions = await loadAllSessions()
  sessionCache = { at: Date.now(), sessions }
  return sessions
}

/** 片段总长度：屏幕上大约就能显示这么多字 */
const SNIPPET_LEN = 24
/** 命中词前面保留几个字，让关键词偏中前 */
const SNIPPET_BEFORE = 6
/** 同一条会话最多返回多少条命中消息；分页负责展示，这里只防极端情况 */
const MAX_HITS_PER_SESSION = 2000

/** 去掉公式、代码块和行内代码：这些内容里的字母不算搜索命中 */
const stripMarkdown = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .replace(/\$\$[\s\S]*?\$\$/g, ' ')
    .replace(/\\\[[\s\S]*?\\\]/g, ' ')
    .replace(/\\\([\s\S]*?\\\)/g, ' ')
    .replace(/\$[^$\n]*\$/g, ' ')

/**
 * 一条消息里可被搜索的文本：用户消息取正文，回答取所有文本块。
 * 公式和代码通常不该当作关键词命中；但如果剥完什么都不剩（整段都是公式），
 * 就退回原文，否则这种对话会整个搜不到。
 */
const textOf = (message: Message): string => {
  const raw =
    message.role === 'user'
      ? message.content
      : message.blocks
          .flatMap((block) => (block.type === 'text' ? [block.text] : []))
          .join('\n')
  const cleaned = stripMarkdown(raw)
  return cleaned.trim() ? cleaned : raw
}

const snippetOf = (text: string, index: number, keyword: string): string => {
  const start = Math.max(0, index - SNIPPET_BEFORE)
  let end = Math.min(text.length, start + SNIPPET_LEN)
  // 窗口里如果有第二处命中，且没贴到右边缘，就让它一起显示并加粗；
  // 贴着边缘的话只保留第一处，免得半个词被切掉。
  const next = text.toLowerCase().indexOf(keyword.toLowerCase(), index + keyword.length)
  if (next >= 0 && next + keyword.length > end - 1) {
    end = Math.min(end, next)
  }
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/**
 * 按标题和对话内容搜索。
 * 结果按「命中的那条消息」展开，和官方一样：同一个会话里多处命中会分别列出来，
 * 这样每条结果都带着可以跳转过去的具体位置；最后按消息时间倒序。
 */
export type SessionSearchResult = {
  hits: SessionSearchHit[]
  /** 命中总数，用于「找到 N 个对话」 */
  total: number
  /** 后面还有没有，加载更多时用 */
  hasMore: boolean
}

export const searchSessions = async (
  query: string,
  offset = 0,
  limit = 30
): Promise<SessionSearchResult> => {
  const keyword = query.trim().toLowerCase()
  if (!keyword) {
    return { hits: [], total: 0, hasMore: false }
  }
  const sessions = await loadSessions()
  // TEMP-DEBUG: 排查「思考」这类对话整个搜不到的问题
  const hits: SessionSearchHit[] = []
  for (const session of sessions) {
    const summary = toSessionSummary(session)
    if (summary.title.toLowerCase().includes(keyword)) {
      hits.push({ ...summary, hitAt: session.updatedAt })
    }
    // 先把这个会话的命中都找出来，只保留最近的那几条：
    // 取最早的几条会因为时间太旧而被同会话的其他结果淹没
    const matched: { snippet: string; messageId: string; hitAt: number }[] = []
    let userMessageAt = session.createdAt
    for (const message of session.messages) {
      if (message.role === 'user') {
        userMessageAt = message.createdAt
      }
      const text = textOf(message)
      if (!text) {
        continue
      }
      const index = text.toLowerCase().indexOf(keyword)
      if (index < 0) {
        continue
      }
      matched.push({
        snippet: snippetOf(text, index, keyword),
        messageId: message.id,
        hitAt: userMessageAt,
      })
    }
    for (const hit of matched.slice(0, MAX_HITS_PER_SESSION)) {
      hits.push({ ...summary, ...hit })
    }
  }
  // 按每条命中自己的消息时间排：同一句话什么时候说的就排在什么时候
  hits.sort((a, b) => (b.hitAt ?? 0) - (a.hitAt ?? 0))
  const page = hits.slice(offset, offset + limit)
  return { hits: page, total: hits.length, hasMore: offset + page.length < hits.length }
}
