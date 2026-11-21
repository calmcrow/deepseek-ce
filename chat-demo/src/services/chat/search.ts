import { loadAllSessions } from './db.js'
import { toSessionSummary, type Message, type SessionSummary } from './types.js'

/** 命中结果：标题命中时没有 snippet，正文命中时带上命中片段 */
export type SessionSearchHit = SessionSummary & { snippet?: string }

/** 片段取命中位置前后各 24 个字 */
const SNIPPET_RADIUS = 24

/** 一条消息里可被搜索的文本：用户消息取正文，回答取所有文本块 */
const textOf = (message: Message): string =>
  message.role === 'user'
    ? message.content
    : message.blocks
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('\n')

const snippetOf = (text: string, index: number, length: number): string => {
  const start = Math.max(0, index - SNIPPET_RADIUS)
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS)
  const body = text.slice(start, end).replace(/\s+/g, ' ').trim()
  return `${start > 0 ? '…' : ''}${body}${end < text.length ? '…' : ''}`
}

/**
 * 按标题和对话内容搜索。标题命中排在前面（不带片段），
 * 正文命中给出命中位置的一小段上下文；结果按最近更新排序。
 */
export const searchSessions = async (query: string): Promise<SessionSearchHit[]> => {
  const keyword = query.trim().toLowerCase()
  if (!keyword) {
    return []
  }
  const sessions = await loadAllSessions()
  const titleHits: SessionSearchHit[] = []
  const contentHits: SessionSearchHit[] = []
  for (const session of sessions) {
    const summary = toSessionSummary(session)
    if (summary.title.toLowerCase().includes(keyword)) {
      titleHits.push(summary)
      continue
    }
    for (const message of session.messages) {
      const text = textOf(message)
      if (!text) {
        continue
      }
      const index = text.toLowerCase().indexOf(keyword)
      if (index >= 0) {
        contentHits.push({ ...summary, snippet: snippetOf(text, index, keyword.length) })
        break
      }
    }
  }
  const byRecent = (a: SessionSearchHit, b: SessionSearchHit) => b.updatedAt - a.updatedAt
  return [...titleHits.sort(byRecent), ...contentHits.sort(byRecent)]
}
