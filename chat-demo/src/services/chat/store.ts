import { create } from 'zustand'
import { createId } from '../../utils/id.js'
import { translate } from '../../i18n/index.js'
import { ApiError, generateTitle, streamMessage } from '../api/client.js'
import { streamRelayMessage } from '../api/relay.js'
import type { ChatModel, CreateMessageRequest } from '../api/types.js'
import { extractFileIds, getFileErrorCode, isRetryableApiError } from '../api/errors.js'
import {
  cancelUpload,
  convertImageToJpeg,
  describeUploadError,
  DOWNSIZE_SIDE,
  isOversizedImage,
  isSupportedImage,
  probeImageSize,
  sniffImageMime,
  uploadAttachment,
  useUploads,
} from '../attachments.js'
import {
  getContextWindow,
  getPresetContent,
  setNetworkModelEnabled,
  useSettings,
} from '../settings.js'
import { appendBranch, getVisibleMessages, normalizeSession, selectVersion } from './branches.js'
import * as db from './db.js'
import {
  clearAllDrafts,
  clearDraft,
  clearSentDraft,
  getDraft,
  prepareDraftMessage,
} from './drafts.js'
import { extractDocumentText } from './splitDocument.js'
import { buildDigest, summarizeDigest, summarizeMessages } from './summarize.js'
import { createLatestReminder } from './latestReminder.js'
import {
  applyEvent,
  canContinueReply,
  CONTEXT_KEEP_ROUNDS,
  getContextRounds,
  getSessionContextUsage,
  hasSendableContent,
  settleReply,
  toCompactMessages,
  toRequestMessages,
} from './reply.js'
import {
  toSessionSummary,
  type AssistantMessage,
  type FileAttachment,
  type Message,
  type Session,
  type SessionSummary,
  type UserMessage,
} from './types.js'
import { showContextCompressPrompt } from '../../components/base/ContextCompressDialog.js'
import { showToast } from '../../components/base/toastState.js'
import { askRemoveUnsupportedImage } from '../../components/base/UnsupportedImageDialog.js'
import { askSendAsText } from '../../components/base/SendAsTextDialog.js'

/** 本轮请求的系统提示词；用户留空时回落到官方默认身份说明，保证请求始终带一段说明。 */
/** 按会话上记的预设取系统提示词；没记就用设置里的默认预设 */
const getSystemPrompt = (presetId?: string): string => getPresetContent(presetId)

/**
 * 实际发出去的系统提示词：预设内容 + 压缩时生成的「前情提要」。
 * 提要放在最后，并按需重复一次关键约束，避免长提要冲淡用户设定的角色。
 */
const buildSystemPrompt = (sessionId: string): string => {
  const session = getSession(sessionId)
  const base = getSystemPrompt(session?.presetId)
  const summary = session?.contextSummary?.trim()
  if (!session?.contextKeepRounds || !summary) {
    return base
  }
  const block = `【前情提要】更早的对话已压缩为以下要点，请把它当作已经发生过的上下文：\n${summary}`
  return base ? `${base}\n\n${block}` : block
}
/** 保留最近打开的详情；当前会话、生成中及尚未成功保存的会话不淘汰。 */
const SESSION_CACHE_LIMIT = 5
/**
 * 官方网页端用 `safety_check.level = 'high'` 声明「扩展模式」，
 * deepseek_web_search / deepseek_read_url 只在扩展模式下可用；审核档位也由它申请。
 * 不带这个字段时服务端会静默忽略工具（表现为「模型说没有实时信息」），
 * 所以这里保持 `{ level: 'high' }`，与官方行为一致。
 */
const SAFETY_CHECK: { level: 'high' } | null = { level: 'high' }
/** 重放原始消息做摘要的字符上限；超过就退回拼接文本，避免摘要请求自己超限 */
const REPLAY_MAX_CHARS = 150_000
/** 服务端判定 file_id 失效后，重新补传并重发的最多次数（不含首次请求） */
const FILE_RETRY_LIMIT = 2
/**
 * 服务端拒绝图片时的 400：格式不支持，或宽高超过 8192 像素。
 * 命中就尝试把会话里的问题图片转码/缩小后再重发。
 */
const UNSUPPORTED_IMAGE_PATTERN =
  /You have uploaded an (unsupported|invalid) image|The image is too large to process[^.]*at most \d+ pixels/i

/** 单次请求的输入上限（32k），超了服务端会直接拒绝 */
const INPUT_TOO_LONG_PATTERN = /user input too long,\s*(\d+)\s*tokens exceeds max\s*(\d+)\s*tokens/i

/**
 * v4-pro 之类的模型会拒掉一些「只有 flash 支持」的字段，报错形如
 * "The latest_reminder message is unavailable for model deepseek-v4-pro. Please use deepseek-flash instead."
 * 抓出模型名，换成能照着做的提示。
 */
const MODEL_FEATURE_UNAVAILABLE_PATTERN = /is unavailable for model\s+([\w.-]+)/i
/** 退避基数，第 n 次重试等待 2^n 倍；连续失败达到上限就放弃，把原始报错展示出来 */
const FILE_RETRY_BASE_DELAY = 1000

/** 官方只在最后一条用户消息里识别 URL；消息里没有链接时声明阅读链接工具没有意义 */
const hasUrl = (text: string) => /https?:\/\/\S+/i.test(text)

/**
 * 服务端工具声明。声明 deepseek_read_url / deepseek_web_search 会把请求送进服务端工具的
 * 扩展链路，而该链路对 document 块支持受限（见 api/types.ts 的 FileBlockParam 注释）。
 * 因此阅读链接只在最后一条用户消息确实带 URL 时才声明（这也是官方的语义），
 * 避免没有链接的普通提问——尤其是带文档附件的提问——无谓进入扩展链路。
 * 智能搜索仍按用户的开关声明。
 */
const serverTools = (search: boolean, text: string): CreateMessageRequest['tools'] => {
  const tools: CreateMessageRequest['tools'] = []
  if (hasUrl(text)) {
    tools.push({ type: 'deepseek_read_url', name: 'deepseek_read_url' })
  }
  if (search) {
    tools.push({ type: 'deepseek_web_search', name: 'deepseek_web_search' })
  }
  return tools
}

/**
 * deepseek-v4-pro 不支持服务端工具（deepseek_web_search / deepseek_read_url）
 * 与服务端标题生成；带上这两个字段会被 400 拒掉，所以按模型关掉。
 */
const supportsServerTools = (model: ChatModel): boolean => !/^deepseek-v4-pro/i.test(model)

type ChatState = {
  ready: boolean
  initError: boolean
  /** 历史导入或全部删除期间锁定交互，提交成功前仍展示原有记录。 */
  importingHistory: boolean
  /** 仅列表元数据，按 updatedAt 降序；流式消息更新不会改变此数组。 */
  sessions: SessionSummary[]
  sessionCache: Record<string, Session>
  sessionLoadErrors: Record<string, boolean>
  sessionSaveErrors: Record<string, boolean>
  /** null 表示新对话（欢迎页） */
  activeId: string | null
  /** 正在生成回复的会话 */
  streaming: Record<string, AbortController>
  /** 手动压缩的进行/完成状态：有值时顶部显示压缩进度条 */
  compressState: { sessionId: string; status: 'running' | 'done' | 'failed' } | null
  /** 最近一次联网检索的结果：网页列表与摘要，供界面展示 */
  webSearch: {
    sessionId: string
    pages: {
      title: string
      url: string
      snippet: string
      siteName?: string
      siteIcon?: string
    }[]
    digest: string
  } | null
}

export const useChatStore = create<ChatState>(() => ({
  ready: false,
  initError: false,
  importingHistory: false,
  sessions: [],
  sessionCache: {},
  sessionLoadErrors: {},
  sessionSaveErrors: {},
  activeId: null,
  streaming: {},
  compressState: null,
  webSearch: null,
}))

const { getState: get, setState: set } = useChatStore

const sortSessions = (sessions: SessionSummary[]) =>
  [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)

const getSession = (id: string) => {
  const cache = get().sessionCache
  return Object.hasOwn(cache, id) ? cache[id] : undefined
}

const getStreamController = (id: string) => {
  const streams = get().streaming
  return Object.hasOwn(streams, id) ? streams[id] : undefined
}

/** 列表项的内容是否没变；用量条上的 token 数与模型变了也算变了，侧边栏要跟着刷新 */
const sameSummary = (a: SessionSummary, b: SessionSummary) =>
  a.title === b.title &&
  a.createdAt === b.createdAt &&
  a.updatedAt === b.updatedAt &&
  (a.pinnedAt ?? 0) === (b.pinnedAt ?? 0) &&
  (a.contextUsage?.tokens ?? -1) === (b.contextUsage?.tokens ?? -1) &&
  (a.contextUsage?.model ?? '') === (b.contextUsage?.model ?? '')

/** 列表项：按当前分支算好上下文用量，侧边栏据此显示用量条 */
const summarizeSession = (session: Session): SessionSummary =>
  toSessionSummary({ ...session, contextUsage: getSessionContextUsage(session) })

const sessionAccess = new Map<string, number>()
const unsavedSessions = new Set<string>()
/** 保存失败时保留原件，重试成功后才释放。 */
const pendingFiles = new Map<string, db.StoredFile[]>()
const deletingSessions = new Set<string>()
const deletionTasks = new Set<Promise<boolean>>()
const streamFlushes = new Map<string, () => void>()
let accessSequence = 0
let historyEpoch = 0
let initTask: Promise<void> | undefined
const sessionLoads = new Map<string, { promise: Promise<void> }>()

const touchSession = (id: string) => sessionAccess.set(id, ++accessSequence)

const trimSessionCache = () => {
  const state = get()
  const ids = Object.keys(state.sessionCache)
  if (ids.length <= SESSION_CACHE_LIMIT) {
    return
  }
  const removable = ids
    .filter(
      (id) =>
        id !== state.activeId &&
        !Object.hasOwn(state.streaming, id) &&
        !unsavedSessions.has(id) &&
        !deletingSessions.has(id)
    )
    .sort((a, b) => (sessionAccess.get(a) ?? 0) - (sessionAccess.get(b) ?? 0))
  const evicted = new Set(removable.slice(0, ids.length - SESSION_CACHE_LIMIT))
  for (const id of evicted) {
    sessionAccess.delete(id)
  }
  if (evicted.size > 0) {
    set({
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([id]) => !evicted.has(id))
      ),
    })
  }
}

const updateSession = (id: string, update: (session: Session) => Session) =>
  set((state) => {
    const previous = Object.hasOwn(state.sessionCache, id) ? state.sessionCache[id] : undefined
    if (!previous) {
      return state
    }
    const session = update(previous)
    if (session === previous) {
      return state
    }
    // 与列表里现有的那一项比较：流式增量没有改变标题、时间与用量时列表不动，
    // 避免每帧都换掉摘要对象、把侧边栏整列重绘一遍。
    const current = state.sessions.find((summary) => summary.id === id)
    const summary = summarizeSession(session)
    return {
      sessionCache: { ...state.sessionCache, [id]: session },
      sessions:
        current && sameSummary(current, summary)
          ? state.sessions
          : sortSessions(state.sessions.map((item) => (item.id === id ? summary : item))),
    }
  })

const updateReply = (sessionId: string, reply: AssistantMessage) =>
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.id === reply.id
        ? { ...reply, parentId: message.parentId, selectedChildId: message.selectedChildId }
        : message
    ),
  }))

const persist = (sessionId: string) => {
  const session = getSession(sessionId)
  if (session) {
    unsavedSessions.add(sessionId)
    if (deletingSessions.has(sessionId)) {
      return
    }
    const epoch = historyEpoch
    const files = pendingFiles.get(sessionId)
    void db
      .saveSession(session, files)
      .then(() => {
        if (epoch !== historyEpoch || !getSession(sessionId)) {
          return
        }
        if (pendingFiles.get(sessionId) === files) {
          pendingFiles.delete(sessionId)
        }
        if (getSession(sessionId) === session) {
          unsavedSessions.delete(sessionId)
          set((state) => ({
            sessionSaveErrors: Object.fromEntries(
              Object.entries(state.sessionSaveErrors).filter(([id]) => id !== sessionId)
            ),
          }))
          trimSessionCache()
        }
      })
      .catch((error: unknown) => {
        db.reportStorageError('save session')(error)
        if (epoch === historyEpoch && getSession(sessionId)) {
          set((state) => ({
            sessionSaveErrors: { ...state.sessionSaveErrors, [sessionId]: true },
          }))
        }
      })
  }
}

export const retrySaveSessions = () => {
  if (!get().importingHistory) {
    unsavedSessions.forEach(persist)
  }
}

/** 离开前先合并尚未绘制的增量；隐藏期间浏览器可能暂停动画帧。 */
export const bindChatPersistence = () => {
  const save = () => {
    if (get().importingHistory) {
      return
    }
    for (const [id, flush] of streamFlushes) {
      flush()
      persist(id)
    }
    for (const id of unsavedSessions) {
      if (!streamFlushes.has(id)) {
        persist(id)
      }
    }
  }
  const onVisibilityChange = () => {
    if (document.visibilityState === 'hidden') {
      save()
    }
  }
  document.addEventListener('visibilitychange', onVisibilityChange)
  window.addEventListener('pagehide', save)
  return () => {
    document.removeEventListener('visibilitychange', onVisibilityChange)
    window.removeEventListener('pagehide', save)
  }
}

/** 按当前开关创建回复：深度思考对应 thinking，智能搜索控制 deepseek_web_search。 */
const createReply = (): AssistantMessage => {
  const { thinking, search, model } = useSettings.getState()
  return {
    id: createId(),
    role: 'assistant',
    createdAt: Date.now(),
    model,
    thinking,
    search,
    prefix: true,
    status: 'pending',
    blocks: [],
  }
}

/** 仍在生成中的回复（页面关闭或导出时未结束）按「已停止」处理 */
const settleInterrupted = (session: Session): Session => {
  if (
    !session.messages.some(
      (m) => m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
    )
  ) {
    return session
  }
  return {
    ...session,
    messages: session.messages.map((m) =>
      m.role === 'assistant' && (m.status === 'pending' || m.status === 'streaming')
        ? settleReply(m, 'stopped', session.updatedAt)
        : m
    ),
  }
}

export const initChat = (): Promise<void> => {
  if (get().ready) {
    return Promise.resolve()
  }
  if (initTask) {
    return initTask
  }
  const epoch = historyEpoch
  set({ initError: false })
  initTask = (async () => {
    try {
      const summaries = await db.loadSessionSummaries()
      if (epoch === historyEpoch) {
        set({ ready: true, sessions: sortSessions(summaries) })
      }
    } catch (error) {
      if (epoch === historyEpoch) {
        set({ initError: true })
        db.reportStorageError('read local sessions')(error)
      }
    } finally {
      if (epoch === historyEpoch) {
        initTask = undefined
      }
    }
  })()
  return initTask
}

/** 同一会话合并并发读取；切换只改变 activeId，旧请求不会把界面切回去。 */
const ensureSessionLoaded = (id: string): Promise<void> => {
  if (getSession(id)) {
    return Promise.resolve()
  }
  const pending = sessionLoads.get(id)
  if (pending) {
    return pending.promise
  }
  const epoch = historyEpoch
  set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: false } }))
  const load = { promise: Promise.resolve() }
  sessionLoads.set(id, load)
  load.promise = (async () => {
    try {
      const stored = await db.loadSession(id)
      if (epoch !== historyEpoch || sessionLoads.get(id) !== load) {
        return
      }
      const summary = get().sessions.find((session) => session.id === id)
      if (!summary) {
        return
      }
      if (!stored) {
        throw new Error(`Session ${id} is missing from local storage`)
      }
      const settled = settleInterrupted(normalizeSession(stored))
      // 列表项按这条会话的消息重算一次：旧记录里没有用量字段，打开会话时顺手补上。
      const latest = summarizeSession(settled)
      // 读取期间可能已在列表重命名，保留最新元数据，不能让旧读取覆盖它。
      const metadataChanged = !sameSummary(latest, summary)
      const session = metadataChanged
        ? {
            ...settled,
            title: summary.title,
            createdAt: summary.createdAt,
            updatedAt: summary.updatedAt,
            pinnedAt: summary.pinnedAt,
          }
        : settled
      touchSession(id)
      set((state) => ({
        sessionCache: { ...state.sessionCache, [id]: session },
        sessions: metadataChanged
          ? sortSessions(state.sessions.map((item) => (item.id === id ? latest : item)))
          : state.sessions,
      }))
      // 只有内容真的变了才整条重存。两个规范化函数在没有变化时原样返回同一个对象，
      // 所以这里的比较是语义比较：补分支字段、收尾中断的回复、列表元数据被改过。
      if (settled !== stored || metadataChanged) {
        persist(id)
      }
      trimSessionCache()
    } catch (error) {
      if (epoch === historyEpoch && sessionLoads.get(id) === load) {
        set((state) => ({ sessionLoadErrors: { ...state.sessionLoadErrors, [id]: true } }))
        db.reportStorageError('read session')(error)
      }
    } finally {
      if (sessionLoads.get(id) === load) {
        sessionLoads.delete(id)
      }
    }
  })()
  return load.promise
}

/** 等所有回复的收尾（落盘）完成 */
const waitForIdle = (sessionId?: string) =>
  new Promise<void>((resolve) => {
    const isIdle = (state: ChatState) =>
      sessionId === undefined
        ? Object.keys(state.streaming).length === 0
        : !Object.hasOwn(state.streaming, sessionId)
    if (isIdle(get())) {
      resolve()
      return
    }
    const unsubscribe = useChatStore.subscribe((state) => {
      if (isIdle(state)) {
        unsubscribe()
        resolve()
      }
    })
  })

/**
 * 替换历史对话：先写入暂存，成功后原子替换旧记录；写入为空即删除全部会话与附件。
 * 期间停止生成并禁止修改会话；失败时清除暂存，保留原有记录。
 */
export const replaceHistory = async (write: () => Promise<void>): Promise<number> => {
  if (get().importingHistory) {
    throw new Error('History replacement is already in progress')
  }
  set({ importingHistory: true })
  try {
    for (const controller of Object.values(get().streaming)) {
      controller.abort()
    }
    // 已开始的单条删除先同步到内存，避免本次替换失败后列表残留已被删除的记录。
    await Promise.all(deletionTasks)
    historyEpoch += 1
    initTask = undefined
    sessionLoads.clear()
    await waitForIdle()
    await db.clearStaging()
    let summaries: SessionSummary[]
    try {
      await write()
      summaries = await db.commitStaging()
    } catch (error) {
      await db.clearStaging().catch(db.reportStorageError('clear unfinished history replacement'))
      throw error
    }
    sessionAccess.clear()
    unsavedSessions.clear()
    pendingFiles.clear()
    clearAllDrafts()
    set({
      ready: true,
      initError: false,
      sessions: sortSessions(summaries),
      sessionCache: {},
      sessionLoadErrors: {},
      sessionSaveErrors: {},
      activeId: null,
    })
    return summaries.length
  } finally {
    set({ importingHistory: false })
    retrySaveSessions()
    const { activeId, ready } = get()
    // 替换失败时恢复被取消的详情读取，原有记录继续可用。
    if (activeId !== null) {
      void ensureSessionLoaded(activeId)
    } else if (!ready) {
      void initChat()
    }
  }
}

/**
 * 合并导入：把新会话追加进列表，其他会话、详情缓存和草稿都不动。
 * 会话与原件已由调用方写库，这里只同步列表，顺序仍按 updatedAt 排列。
 */
export const addImportedSession = (session: Session) => {
  set((state) => ({ sessions: sortSessions([...state.sessions, summarizeSession(session)]) }))
}

/** 切换这条会话使用的系统提示词预设；只影响之后发出的请求 */
export const setSessionPreset = (id: string, presetId: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, presetId }))
    persist(id)
  }
}

export const newChat = () => {  if (!get().importingHistory) {
    set({ activeId: null })
    trimSessionCache()
  }
}

export const selectSession = (id: string) => {
  if (!get().importingHistory && get().sessions.some((session) => session.id === id)) {
    touchSession(id)
    set({ activeId: id })
    void ensureSessionLoaded(id)
    trimSessionCache()
  }
}

export const renameSession = (id: string, title: string) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, title }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, title } : session
      ),
    }))
    void db.renameSession(id, title).catch(db.reportStorageError('rename session'))
  }
}

/**
 * 置顶 / 取消置顶。和重命名一样：会话已加载就直接改内存并落盘，
 * 没加载则只更新列表项并异步写库，避免为了置顶把整个会话读出来。
 */
export const pinSession = (id: string, pinned: boolean) => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return
  }
  const pinnedAt = pinned ? Date.now() : undefined
  if (getSession(id)) {
    updateSession(id, (session) => ({ ...session, pinnedAt }))
    persist(id)
  } else {
    set((state) => ({
      sessions: state.sessions.map((session) =>
        session.id === id ? { ...session, pinnedAt } : session
      ),
    }))
    void db.setSessionPinned(id, pinnedAt ?? null).catch(db.reportStorageError('pin session'))
  }
}

/**
 * 删除会话；本地原件仅在没有其他会话引用时清理。远端文件不删：导入、编辑、重新生成都会复用同一个附件，
 * 同一服务端文件可能被多个会话引用，不维护引用计数。
 */
export const removeSession = (id: string): Promise<boolean> => {
  const task = removeSessionData(id).finally(() => deletionTasks.delete(task))
  deletionTasks.add(task)
  return task
}

const removeSessionData = async (id: string): Promise<boolean> => {
  if (get().importingHistory || deletingSessions.has(id)) {
    return false
  }
  const epoch = historyEpoch
  deletingSessions.add(id)
  try {
    getStreamController(id)?.abort()
    // 等本会话的流收尾，避免删除之后又被收尾保存写回来。
    await waitForIdle(id)
    if (epoch !== historyEpoch) {
      return false
    }
    await db.deleteSession(id)
    if (epoch !== historyEpoch) {
      return true
    }
    sessionLoads.delete(id)
    sessionAccess.delete(id)
    unsavedSessions.delete(id)
    pendingFiles.delete(id)
    clearDraft(id)
    set((state) => ({
      sessions: state.sessions.filter((session) => session.id !== id),
      sessionCache: Object.fromEntries(
        Object.entries(state.sessionCache).filter(([key]) => key !== id)
      ),
      sessionLoadErrors: Object.fromEntries(
        Object.entries(state.sessionLoadErrors).filter(([key]) => key !== id)
      ),
      sessionSaveErrors: Object.fromEntries(
        Object.entries(state.sessionSaveErrors).filter(([key]) => key !== id)
      ),
      activeId: state.activeId === id ? null : state.activeId,
    }))
    return true
  } catch (error) {
    db.reportStorageError('delete session')(error)
    return false
  } finally {
    deletingSessions.delete(id)
    // 删除失败时保留会话，并保存停止生成后的最新状态。
    if (getSession(id)) {
      if (get().importingHistory) {
        unsavedSessions.add(id)
      } else {
        persist(id)
      }
    }
  }
}

/** 多选删除：逐条走单条的清理逻辑，返回真正删掉的条数 */
export const removeSessions = async (ids: string[]): Promise<number> => {
  let removed = 0
  for (const id of ids) {
    if (await removeSession(id)) {
      removed += 1
    }
  }
  return removed
}

export const stopReply = (sessionId: string) => getStreamController(sessionId)?.abort()

/**
 * 提交指定会话的最新草稿；null 表示新建会话。
 * 同步接收成功才清空草稿，附件原件由会话接管；保存失败仍通过保存入口重试。
 */
export const sendMessage = (targetSessionId: string | null) => {
  if (get().importingHistory || !get().ready) {
    return false
  }
  const prepared = prepareDraftMessage(getDraft(targetSessionId), useUploads.getState().tasks)
  if (!prepared) {
    return false
  }
  const { text, files } = prepared
  const now = Date.now()
  let sessionId = targetSessionId
  if (
    sessionId !== null &&
    (deletingSessions.has(sessionId) || getStreamController(sessionId) || !getSession(sessionId))
  ) {
    return false
  }
  if (sessionId === null) {
    const session: Session = {
      id: createId(),
      title: '',
      createdAt: now,
      updatedAt: now,
      messages: [],
      rootMessageId: null,
      // 新会话默认用设置里选定的那个预设
      presetId: useSettings.getState().defaultPromptPresetId,
    }
    sessionId = session.id
    touchSession(session.id)
    set((state) => ({
      sessions: [summarizeSession(session), ...state.sessions],
      sessionCache: { ...state.sessionCache, [session.id]: session },
      activeId: session.id,
    }))
  }
  const current = getSession(sessionId)
  if (!current) {
    return false
  }
  const history = getVisibleMessages(current)
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files.map(({ id, serverId, name, size, isImage, mimeType }) => ({
      id,
      serverId,
      name,
      size,
      isImage,
      mimeType,
    })),
    createdAt: now,
  }
  const reply = createReply()
  updateSession(sessionId, (session) => ({
    ...appendBranch(session, history.at(-1)?.id ?? null, [question, reply]),
    updatedAt: now,
  }))
  if (files.length > 0) {
    pendingFiles.set(sessionId, [
      ...(pendingFiles.get(sessionId) ?? []),
      ...files.map(({ id, blob }) => ({ id, blob })),
    ])
  }
  persist(sessionId)
  clearSentDraft(targetSessionId)
  void streamReply(sessionId, reply, { history, question })
  return true
}

/** 重新生成当前路径上的回答：在原问题下新增版本，不覆盖旧回答和后续对话。 */
export const regenerateReply = (sessionId: string, messageId?: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index =
    messageId === undefined ? path.length - 1 : path.findIndex((m) => m.id === messageId)
  const question = path[index - 1]
  if (question?.role !== 'user' || path[index]?.role !== 'assistant') {
    return
  }
  const history = path.slice(0, index - 1)
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, question.id, [reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history, question })
}

/** 编辑提问后新增同父版本，保留原文件；旧问题的所有回答与后续对话仍可切回。 */
export const editMessage = (
  sessionId: string,
  messageId: string,
  content: string,
  /** 编辑后保留的附件；不传则沿用原消息 */
  files?: UserMessage['files']
): boolean => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return false
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return false
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const previous = path[index]
  const text = content.trim()
  if (previous?.role !== 'user' || (!text && previous.files.length === 0)) {
    return false
  }
  const question: UserMessage = {
    id: createId(),
    role: 'user',
    content: text,
    files: files ?? previous.files,
    createdAt: Date.now(),
  }
  const reply = createReply()
  updateSession(sessionId, (s) => ({
    ...appendBranch(s, path[index - 1]?.id ?? null, [question, reply]),
    updatedAt: Date.now(),
  }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index), question })
  return true
}

export const selectMessageVersion = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  if (getStreamController(sessionId)) {
    return
  }
  updateSession(sessionId, (session) => selectVersion(session, messageId))
  persist(sessionId)
}

/** 继续最后一条未完成的回答：保留原消息与开关，仅将新流的内容追加到原块之后。 */
export const continueReply = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const question = path.at(-2)
  const previous = path.at(-1)
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.id !== messageId ||
    !canContinueReply(previous)
  ) {
    return
  }
  const { thinking, search, model } = useSettings.getState()
  const reply: AssistantMessage = {
    ...previous,
    // 未记录请求配置的回复，续写时使用当前设置里的模型和开关。
    model: previous.model ?? model,
    thinking: previous.thinking ?? thinking,
    search: previous.search ?? search,
    status: 'pending',
    stopReason: undefined,
    stopDetails: undefined,
    error: undefined,
  }
  updateReply(sessionId, reply)
  updateSession(sessionId, (s) => ({ ...s, updatedAt: Date.now() }))
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, -2), question, prefix: previous })
}

/** 附件补传失败后重试：保留原回答位置，重新补传并请求 */
export const retryUpload = (sessionId: string, messageId: string) => {
  if (get().importingHistory || deletingSessions.has(sessionId)) {
    return
  }
  const session = getSession(sessionId)
  if (!session || getStreamController(sessionId)) {
    return
  }
  const path = getVisibleMessages(session)
  const index = path.findIndex((message) => message.id === messageId)
  const question = path[index - 1]
  const previous = path[index]
  if (
    question?.role !== 'user' ||
    previous?.role !== 'assistant' ||
    previous.error?.kind !== 'upload'
  ) {
    return
  }
  const reply: AssistantMessage = { ...previous, status: 'pending', error: undefined }
  updateReply(sessionId, reply)
  persist(sessionId)
  void streamReply(sessionId, reply, { history: path.slice(0, index - 1), question })
}

type Request = { history: Message[]; question: UserMessage; prefix?: AssistantMessage }

/**
 * 压缩上下文：只截断发给模型的上下文，本地消息一条都不删（旧消息照常展示、照常导出）。
 * 标记记在会话对象上由 db.saveSession 落盘；导入/导出的归档格式是官方格式，不含这个字段，
 * 所以换设备或重新导入后标记可能丢失——最坏的情况是再提示一次，可以接受。
 */
let compressClearTimer: ReturnType<typeof setTimeout> | undefined

/** 压缩结束：显示结果，5 秒后自动收起 */
const settleCompressState = (sessionId: string, status: 'done' | 'failed') => {
  set({ compressState: { sessionId, status } })
  clearTimeout(compressClearTimer)
  compressClearTimer = setTimeout(() => {
    set({ compressState: null })
  }, 5000)
}

export const compressContext = async (sessionId: string): Promise<boolean> => {
  if (get().importingHistory) {
    return false
  }
  // 会话可能还没进内存（直接从侧栏菜单压缩时）：先读出来再算提要
  const cached = getSession(sessionId)
  const session = cached ?? (await db.loadSession(sessionId))
  if (!session) {
    settleCompressState(sessionId, 'failed')
    return false
  }
  set({ compressState: { sessionId, status: 'running' } })
  let summary: string | undefined = session.contextSummary
  let summaryRounds = session.contextSummaryRounds
  // 先让模型给「要被裁掉的那些轮」写一份提要，之后每轮请求都带着它，
  // 这样压缩只是不再逐字重发旧内容，模型仍然知道前面发生了什么。
  const rounds = getContextRounds(session.messages)
  // 上一次已经摘要到第几轮：二次压缩只把「新掉出窗口的轮次」补进提要，避免重复摘要旧内容
  const summarizedRounds = session.contextSummary ? (session.contextSummaryRounds ?? 0) : 0
  const dropped = rounds.slice(
    summarizedRounds,
    Math.max(summarizedRounds, rounds.length - CONTEXT_KEEP_ROUNDS)
  )
  const apiKey = useSettings.getState().apiKey
  // 优先重放原始消息：模型看到真实对话结构（含工具结果块），比拼接文本更完整；
  // 内容太大时退回拼接文本，避免摘要请求自己超限。
  const replay = toCompactMessages(dropped)
  if (summary) {
    replay.unshift({ role: 'user', content: `【上一版前情提要】\n${summary}` })
  }
  const replayChars = JSON.stringify(replay).length
  if ((dropped.length > 0 || summary) && apiKey) {
    showToast({ key: 'contextSummarizing' })
    try {
      const signal = new AbortController().signal
      const text =
        replayChars <= REPLAY_MAX_CHARS
          ? await summarizeMessages({
              apiKey,
              model: useSettings.getState().model,
              // 复用会话自己的系统提示词，让压缩请求的前缀命中上下文缓存
              system: buildSystemPrompt(sessionId),
              messages: replay,
              signal,
            })
          : await summarizeDigest({
              apiKey,
              model: useSettings.getState().model,
              digest: summary ? `${summary}\n\n${buildDigest(dropped)}` : buildDigest(dropped),
              signal,
            })
      if (text) {
        summary = text
        // 记「摘要覆盖到第几轮」= 被裁掉的边界，而不是会话总轮数：
        // 下次压缩时只补这之后的轮次，不会重复摘要旧内容
        summaryRounds = Math.max(0, rounds.length - CONTEXT_KEEP_ROUNDS)
      }
    } catch {
      // 提要失败不该挡住压缩本身：只压缩，并告诉用户这次没有提要
      summary = undefined
      summaryRounds = undefined
      showToast({ key: 'contextSummaryFailed', type: 'error' })
    }
  }
  const next: Session = {
    ...session,
    contextKeepRounds: CONTEXT_KEEP_ROUNDS,
    // 压缩成功后先把上下文大小置空，等下一次回答的 usage 再显示真实值
    contextUsageCleared: true,
    // 压缩完清掉「已提示」标记：下次上下文再满时重新提示，可以再压一次
    contextPromptedAt: undefined,
    ...(summary ? { contextSummary: summary, contextSummaryRounds: summaryRounds } : {}),
    ...(summary ? {} : { contextSummary: undefined, contextSummaryRounds: undefined }),
  }
  if (cached) {
    updateSession(sessionId, () => next)
    persist(sessionId)
  } else {
    // 没进内存时直接落库；列表摘要也要同步「上下文大小先置空」
    await db.saveSession(next)
    set((state) => ({
      sessions: state.sessions.map((summary) =>
        summary.id === sessionId
          ? { ...summary, contextUsage: getSessionContextUsage(next) }
          : summary
      ),
    }))
  }
  settleCompressState(sessionId, 'done')
  showToast({ key: 'contextCompressed' })
  return true
}

/**
 * 一条回复结束后算一次上下文用量：达到模型的上下文窗口时提示压缩。
 * 同一条会话只提示一次（contextPromptedAt 落盘）：压缩过、或用户选了「暂不」都不再打扰。
 */
const promptContextCompress = (sessionId: string) => {
  const session = getSession(sessionId)
  if (!session || session.contextPromptedAt || get().importingHistory) {
    return
  }
  const usage = getSessionContextUsage(session)
  if (!usage || usage.tokens < getContextWindow(usage.model)) {
    return
  }
  updateSession(sessionId, (current) => ({ ...current, contextPromptedAt: Date.now() }))
  persist(sessionId)
  showContextCompressPrompt(() => compressContext(sessionId))
}

/** 把补传得到的 serverId 写回会话里所有引用同一附件的消息（编辑、重新生成会共用附件） */
const saveServerIds = (sessionId: string, serverIds: Map<string, string>) => {
  if (serverIds.size === 0) {
    return
  }
  updateSession(sessionId, (session) => ({
    ...session,
    messages: session.messages.map((message) =>
      message.role === 'user' && message.files.some((file) => serverIds.has(file.id))
        ? {
            ...message,
            files: message.files.map((file) =>
              serverIds.has(file.id) ? { ...file, serverId: serverIds.get(file.id) ?? null } : file
            ),
          }
        : message
    ),
  }))
  persist(sessionId)
}

/**
 * 附件的服务端 id：已有直接用；正在上传的等待同一任务；否则读取本地原件补传。
 * 本地也没有原件（导入的文档附件只有元数据）时返回 null，该附件只展示、不进入请求。
 */
const ensureServerId = async (apiKey: string, file: FileAttachment): Promise<string | null> => {
  if (file.serverId) {
    return file.serverId
  }
  const task = useUploads.getState().tasks[file.id]
  if (task?.status === 'done') {
    return task.serverId
  }
  const blob = await db.loadFile(file.id)
  if (!blob) {
    return null
  }
  return uploadAttachment(apiKey, file.id, blob, file.name, file.isImage)
}

/** 用会话里的最新消息替换请求快照：重传前会重置附件的 serverId，快照必须跟着更新 */
const refreshRequest = (sessionId: string, request: Request): Request => {
  const session = getSession(sessionId)
  if (!session) {
    return request
  }
  const byId = new Map(session.messages.map((message) => [message.id, message]))
  const pick = <T extends Message>(message: T): T =>
    (byId.get(message.id) as T | undefined) ?? message
  return {
    history: request.history.map(pick),
    question: pick(request.question),
    prefix: request.prefix,
  }
}

/**
 * 发送前补齐附件的 serverId。
 * - 本轮提问的附件并行补齐，任一失败则整体失败，已成功的照常写回，重试时复用成功结果；
 * - 历史轮次（仅进入上下文的）中没有 serverId 的附件，多为导入的图片：从最新的消息往前逐张补传，
 *   失败静默跳过，该附件不进入本次请求，下次发送时再试。
 */
const prepareFiles = async (sessionId: string, request: Request, signal: AbortSignal) => {
  const epoch = historyEpoch
  // 服务端判定 file_id 失效时会清掉会话里的 serverId，先用最新消息替换请求快照，
  // 否则快照里仍是旧 id，补传会直接复用它。
  request = refreshRequest(sessionId, request)
  const apiKey = useSettings.getState().apiKey ?? ''
  const serverIds = new Map<string, string>()
  // 停止生成立即生效；上传本身不取消（输入框与其他消息可能共用同一任务），完成后照常写回 serverId
  const aborted = new Promise<never>((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
  const uploads = Promise.allSettled(
    request.question.files.map(async (file) => {
      const serverId = await ensureServerId(apiKey, file)
      if (serverId) {
        serverIds.set(file.id, serverId)
      }
    })
  )
  void uploads.then(() => {
    if (epoch === historyEpoch) {
      saveServerIds(sessionId, serverIds)
    }
  })
  const results = await Promise.race([uploads, aborted])
  const failed = results.find((result) => result.status === 'rejected')
  if (failed) {
    throw failed.reason
  }

  const pending = new Map<string, FileAttachment>()
  // 压缩过的会话只补传真正会进入请求的那些轮次的附件
  const keepRounds = getSession(sessionId)?.contextKeepRounds
  for (const [user] of getContextRounds(request.history, keepRounds).toReversed()) {
    for (const file of user.files) {
      if (!file.serverId && !serverIds.has(file.id) && !pending.has(file.id)) {
        pending.set(file.id, file)
      }
    }
  }
  for (const file of pending.values()) {
    signal.throwIfAborted()
    try {
      const serverId = await Promise.race([ensureServerId(apiKey, file), aborted])
      if (serverId) {
        serverIds.set(file.id, serverId)
        saveServerIds(sessionId, new Map([[file.id, serverId]]))
      }
    } catch {
      signal.throwIfAborted()
    }
  }

  // 用补齐后的会话重新取历史与提问，保证请求里都是 serverId
  const session = getSession(sessionId)
  const resolve = <T extends Message>(message: T): T =>
    (session?.messages.find((m) => m.id === message.id) as T | undefined) ?? message
  return {
    history: request.history.map(resolve),
    question: resolve(request.question),
    prefix: request.prefix,
  }
}

/** 本次请求实际会用到的服务端 file_id；压缩过的会话只算真正进入请求的轮次 */
const collectServerFileIds = (request: Request, keepRounds?: number): Set<string> => {
  const ids = new Set<string>()
  const add = (files: FileAttachment[]) => {
    for (const file of files) {
      if (file.serverId) {
        ids.add(file.serverId)
      }
    }
  }
  add(request.question.files)
  for (const [user] of getContextRounds(request.history, keepRounds)) {
    add(user.files)
  }
  return ids
}

/**
 * 服务端判定 file_id 失效时，清掉对应附件的 serverId 并丢弃旧的上传任务，
 * 下一次补齐会重新读取本地原件上传。报错里点名了 file_id 就只重置这些，
 * 没点名（如 invalid file_id）则重置本次请求用到的全部附件。
 */
const reuploadInvalidatedFiles = (sessionId: string, request: Request, error: unknown): boolean => {
  if (!(error instanceof ApiError) || !getFileErrorCode(error)) {
    return false
  }
  const mentioned = extractFileIds(error.message)
  // 重试时原始快照里还是上一轮已被清掉的 serverId，先换成会话里的最新消息
  const targets =
    mentioned.length > 0
      ? new Set(mentioned)
      : collectServerFileIds(
          refreshRequest(sessionId, request),
          getSession(sessionId)?.contextKeepRounds
        )
  const session = getSession(sessionId)
  if (targets.size === 0 || !session) {
    return false
  }
  const localIds: string[] = []
  const messages = session.messages.map((message) => {
    if (message.role !== 'user') {
      return message
    }
    let changed = false
    const files = message.files.map((file) => {
      if (!file.serverId || !targets.has(file.serverId)) {
        return file
      }
      localIds.push(file.id)
      changed = true
      return { ...file, serverId: null }
    })
    return changed ? { ...message, files } : message
  })
  if (localIds.length === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({ ...current, messages }))
  // 上传任务里可能还留着同一个失效的 serverId，清掉后 ensureServerId 才会重新上传
  localIds.forEach(cancelUpload)
  persist(sessionId)
  return true
}

/** 重传前的退避等待；停止生成时立即返回，由调用方按已停止收尾 */
/**
 * 服务端按真实字节只认 JPEG/PNG/GIF/WebP。老版本会把 HEIC 等格式传上去并写进历史消息，
 * 之后每一轮请求都会带着这个坏 file_id 被 400。这里只针对「刚报这个 400 的会话」做一次定向修复：
 * 把本地原件转成 JPEG、写回同一个文件 id，并清掉 serverId，让重发时重新上传。
 * 转换不可逆，所以只在该错误真的发生时触发，不做全库扫描。
 */
const repairSessionImages = async (sessionId: string): Promise<boolean> => {
  const session = getSession(sessionId)
  if (!session) {
    return false
  }
  const fixed = new Map<string, { name: string; size: number }>()
  for (const message of session.messages) {
    if (message.role !== 'user' || message.files.length === 0) {
      continue
    }
    for (const file of message.files) {
      if (!file.isImage || fixed.has(file.id)) {
        continue
      }
      const blob = await db.loadFile(file.id)
      if (!blob) {
        continue
      }
      const mime = (await sniffImageMime(blob)) || file.mimeType
      const supported = isSupportedImage(mime)
      // 格式没问题也可能超尺寸（服务端限制宽高各不超过 8192 像素），一并处理
      if (supported && !isOversizedImage(await probeImageSize(blob))) {
        continue
      }
      const jpeg = await convertImageToJpeg(
        new File([blob], file.name || file.id, { type: mime || 'application/octet-stream' }),
        supported ? DOWNSIZE_SIDE : undefined
      )
      if (!jpeg) {
        continue
      }
      await db.saveFiles([{ id: file.id, blob: jpeg }])
      fixed.set(file.id, { name: jpeg.name, size: jpeg.size })
    }
  }
  if (fixed.size === 0) {
    return false
  }
  updateSession(sessionId, (current) => ({
    ...current,
    messages: current.messages.map((message) => {
      if (message.role !== 'user') {
        return message
      }
      return {
        ...message,
        files: message.files.map((file) => {
          const patch = fixed.get(file.id)
          return patch ? { ...file, ...patch, mimeType: 'image/jpeg', serverId: null } : file
        }),
      }
    }),
  }))
  persist(sessionId)
  return true
}

/**
 * 修复不了时（本地原件缺失、或系统解不了这种格式）的兜底：
 * 把这些拿不准的图片附件从会话里摘掉，让对话还能继续。原件仍留在本地库里，不影响导出以外的功能。
 *
 * `preferredIds` 是「本次请求里真的发出去的图片」：服务端刚拒过它们，
 * 用户也点了移除，就优先摘这些。否则（例如已成功转成 JPEG、mime 看起来合法，
 * 但服务端依然不接受）按格式启发式判断会一个都删不掉，等于点了没反应。
 */
const removeUnsupportedImages = async (
  sessionId: string,
  preferredIds: string[] = []
): Promise<string[]> => {
  const session = getSession(sessionId)
  if (!session) {
    return []
  }
  const drop = new Set<string>()
  const preferred = new Set(preferredIds)
  for (const message of session.messages) {
    if (message.role !== 'user' || message.files.length === 0) {
      continue
    }
    for (const file of message.files) {
      if (file.isImage && preferred.has(file.id)) {
        drop.add(file.id)
      }
    }
  }
  // 请求里没有图片（或都已不在会话里）时，退回按格式判断
  if (drop.size === 0) {
    for (const message of session.messages) {
      if (message.role !== 'user' || message.files.length === 0) {
        continue
      }
      for (const file of message.files) {
        if (!file.isImage || drop.has(file.id)) {
          continue
        }
        const blob = await db.loadFile(file.id)
        const mime = blob ? (await sniffImageMime(blob)) || file.mimeType : file.mimeType
        if (!blob || !isSupportedImage(mime)) {
          drop.add(file.id)
        }
      }
    }
  }
  if (drop.size === 0) {
    return []
  }
  updateSession(sessionId, (current) => ({
    ...current,
    messages: current.messages.map((message) =>
      message.role !== 'user'
        ? message
        : { ...message, files: message.files.filter((file) => !drop.has(file.id)) }
    ),
  }))
  persist(sessionId)
  return [...drop]
}

const waitForRetry = (attempt: number, signal: AbortSignal) =>  new Promise<void>((resolve) => {
    function onAbort() {
      clearTimeout(timer)
      resolve()
    }
    const timer = setTimeout(
      () => {
        signal.removeEventListener('abort', onAbort)
        resolve()
      },
      FILE_RETRY_BASE_DELAY * 2 ** attempt
    )
    signal.addEventListener('abort', onAbort, { once: true })
  })

/**
 * 请求并消费流：先补齐附件的 serverId，再发请求；流式增量按动画帧刷新内存，完成、失败或停止后落盘。
 * 补传失败时回复记为 upload 错误，可重试。
 * 服务端判定 file_id 失效时重新补传后重发，退避重试且次数有上限，超过则按原始报错收尾。
 */
/** 实验性：用指定模型执行联网检索（搜索/读链接），把资料交给当前模型回答；失败重试一次 */
const runFlashSearch = async (
  apiKey: string,
  question: string,
  model: ChatModel,
  signal: AbortSignal
): Promise<{
  digest: string
  pages: { title: string; url: string; snippet: string; siteName?: string; siteIcon?: string }[]
} | null> => {
  if (!apiKey || signal.aborted) {
    return null
  }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const controller = new AbortController()
    const onAbort = () => controller.abort()
    signal.addEventListener('abort', onAbort, { once: true })
    let text = ''
    const pages: {
      title: string
      url: string
      snippet: string
      siteName?: string
      siteIcon?: string
    }[] = []
    try {
      const events = streamMessage(
        apiKey,
        {
          model,
          system:
            '你是联网搜索助手。根据用户的问题执行联网搜索或读取其中的链接，只输出与问题最相关的资料摘要，' +
            '包含关键事实、数据与来源链接，最多 1500 字；不要直接回答用户问题。',
          messages: [{ role: 'user', content: question }],
          thinking: { type: 'disabled' },
          ...(SAFETY_CHECK ? { safety_check: SAFETY_CHECK } : {}),
          tools: serverTools(true, question),
        },
        controller.signal
      )
      for await (const event of events) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          text += event.delta.text
        } else if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'web_search_tool_result'
        ) {
          for (const item of event.content_block.content) {
            if (item.type === 'web_search_result') {
              pages.push({
              title: item.title,
              url: item.url,
              snippet: item.snippet,
              ...(item.site_name ? { siteName: item.site_name } : {}),
              ...(item.site_icon ? { siteIcon: item.site_icon } : {}),
            })
            }
          }
        }
      }
      return text.trim() ? { digest: text.trim(), pages } : null
    } catch (error) {
      if (attempt === 1) {
        return null
      }
      // 网络抖动：稍等一拍再试
      await new Promise((resolve) => setTimeout(resolve, 800))
    } finally {
      signal.removeEventListener('abort', onAbort)
      controller.abort()
    }
  }
  return null
}

/** 先把搜索调用挂到回答最前面：官方步骤条立刻显示在上方 */
const attachSearchUse = (
  reply: AssistantMessage,
  toolId: string,
  query: string
): AssistantMessage => ({
  ...reply,
  blocks: [
    {
      type: 'server_tool_use',
      id: toolId,
      name: 'deepseek_web_search',
      input: { action: 'search', query, queries: query ? [query] : [] },
      caller: { type: 'direct' },
      kind: 'search',
    },
    ...reply.blocks,
  ],
})

/** 回答结束后再补搜索到的网页：官方底部站点条与可点击引用都靠这个块 */
const attachSearchResult = (
  reply: AssistantMessage,
  toolId: string,
  pages: { title: string; url: string; snippet: string; siteName?: string; siteIcon?: string }[]
): AssistantMessage => {
  // 官方正文用 [citation:N] 渲染可点击角标；模型可能写 [N] 或（一）（二），这里统一转换
  const cnNumbers: Record<string, number> = {
    一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
    十: 10, 十一: 11, 十二: 12, 十三: 13, 十四: 14, 十五: 15,
  }
  const toCitation = (text: string) =>
    text
      .replace(/[（(]([一二三四五六七八九十]{1,2})[)）]/g, (match, cn: string) => {
        const index = cnNumbers[cn]
        return index && index <= pages.length ? `[citation:${index}]` : match
      })
      .replace(/\[(\d{1,2})\]/g, (match, num: string) => {
        const index = Number(num)
        return index >= 1 && index <= pages.length ? `[citation:${index}]` : match
      })
  // 引用只在模型自己写的位置渲染；随机分配会误导用户，不做兜底
  const blocksWithRefs = reply.blocks.map((block) =>
    block.type === 'text' ? { ...block, text: toCitation(block.text) } : block
  )
  return {
    ...reply,
    blocks: [
      ...blocksWithRefs,
      {
        type: 'web_search_tool_result',
        tool_use_id: toolId,
        content: pages.map((page) => ({
          type: 'web_search_result' as const,
          title: page.title,
          url: page.url,
          snippet: page.snippet,
          site_icon: page.siteIcon ?? null,
          site_name: page.siteName ?? null,
          encrypted_content: '',
          page_age: null,
        })),
        kind: 'search',
      },
    ],
  }
}

/** 标题清洗：取第一行、去引号/前缀、限长 */
const sanitizeTitle = (raw: string): string => {
  const line = (raw.split(/\r?\n/)[0] ?? '').trim()
  return line
    .replace(/^#+\s*/, '')
    .replace(/^["'“”‘’「」【】\s]+|["'“”‘’「」【】\s]+$/g, '')
    .slice(0, 24)
}

const streamReply = async (sessionId: string, initial: AssistantMessage, request: Request) => {
  const controller = new AbortController()
  // 服务端给「生成标题」单独设了 32768 的输入预算，带附件时会被文档直接顶爆。
  // 标题：先用提问文字（没有文字就用附件名）做本地兜底，再发一次独立的小请求让模型取更好的。
  // 独立请求只带用户文字，不参与主请求的输入预算，因此不会被文档撑爆。
  const existingTitle = getSession(sessionId)?.title
  const isFirstPrompt = !existingTitle || existingTitle === translate('untitledChat')
  if (!existingTitle) {
    // 还没生成标题时用占位，不拿用户提问截断当标题
    const fallback = translate('untitledChat')
    if (fallback) {
      updateSession(sessionId, (session) => (session.title ? session : { ...session, title: fallback }))
    }
  }
  set((state) => ({ streaming: { ...state.streaming, [sessionId]: controller } }))
  let reply = initial
  /** 自定义联网检索到的网页：回答结束后挂成官方工具结果块 */
  let injectedPages: { title: string; url: string; snippet: string; siteName?: string; siteIcon?: string }[] | null =
    null
  let injectedToolId: string | null = null
  /** 服务端返回的标题（开启标题且生成成功时） */
  let serverTitle: string | null = null
  let frame = 0
  const flush = () => {
    cancelAnimationFrame(frame)
    frame = 0
    updateReply(sessionId, reply)
  }
  streamFlushes.set(sessionId, flush)

  try {
    /** 正文直发的附件（撞到解析通道 32k 上限后改走文本块），跨重试保留 */
    const textDocuments = new Map<string, string>()
    for (let attempt = 0; ; attempt += 1) {
      /** 附件补齐前出错属于上传失败，请求还没有发出 */
      let preparing = true
      let receivedContent = false
      try {
        const prepared = await prepareFiles(sessionId, request, controller.signal)
        preparing = false
        // 附件就绪后获取本轮信息；续写沿用原回答快照，重新生成的快照独立保存。
        const latestReminder = prepared.prefix
          ? prepared.prefix.latestReminder
          : createLatestReminder(useSettings.getState())
        reply = { ...reply, latestReminder }
        updateReply(sessionId, reply)
        persist(sessionId)
        // 实验性：当前模型不支持联网工具时，用「联网使用的模型」检索，把资料拼进提问交给当前模型
        const wantsWebAccess =
          (initial.search ?? false) || hasUrl(prepared.question.content)
        // 只有开启自定义联网模型时才单独检索；关闭时由对话模型自己联网（主请求带工具）
        const needsWebAccess = wantsWebAccess && useSettings.getState().networkModelEnabled
        let questionForRequest = prepared.question
        let webDigest: string | null = null
        let webNotice: string | null = null
        if (needsWebAccess) {
          const networkModel = useSettings.getState().networkModel
          const found = await runFlashSearch(
            useSettings.getState().apiKey ?? '',
            prepared.question.content,
            networkModel,
            controller.signal
          )
          webDigest = found?.digest ?? null
          if (found) {
            // 一份给当前模型（当作它自己的检索结果，带编号方便引用），一份留给界面展示
            const numbered = found.pages
              .map(
                (page, index) =>
                  `[${index + 1}] ${page.siteName ?? ''} ${page.title}\n${page.url}\n${page.snippet}`
              )
              .join('\n\n')
            questionForRequest = {
              ...prepared.question,
              content: `【助手联网检索结果｜这是你自己调用的联网搜索服务返回的内容，不是用户提供的资料，请直接当作你的检索结果使用。回答规则：1) 尽量采用资料中最新的信息，但不要因为无法判断日期、信息有冲突或资料不完整就省略相关内容——资料里有的都应当呈现；2) 不要以「知识截止」为由拒绝；3) 引用资料时写括号数字（一）（二）（三）…，对应下面网页列表的编号；4) 必须把引用就近写在对应的事实/段落后面（例如“市值蒸发约 5000 亿美元（三）”），不要把引用全部堆在回答末尾；5) 回答里只要用了资料，就必须出现括号数字引用】\n${numbered ? `${numbered}\n\n` : ''}【检索摘要】\n${found.digest}\n\n【用户问题】\n${prepared.question.content}`,
            }
            set({ webSearch: { sessionId, pages: found.pages, digest: found.digest } })
            injectedPages = found.pages
            injectedToolId = `srvtoolu_s_${Date.now()}_${createId().slice(0, 8)}`
            reply = attachSearchUse(reply, injectedToolId, prepared.question.content)
            updateReply(sessionId, reply)
          } else {
            // 联网模型失败：自动关闭实验性功能，不弹客户端错误，交给对话模型向用户说明
            setNetworkModelEnabled(false)
            webNotice = `【系统提示】你选择的联网模型「${networkModel}」无法联网，本次没有进行网页检索；实验性联网功能已自动关闭。请在回答开头向用户说明这一点。`
            questionForRequest = {
              ...prepared.question,
              content: `${webNotice}\n\n【用户问题】\n${prepared.question.content}`,
            }
          }
        }
        // 正文为空、附件又没有 serverId（上传失败，或坏图被摘掉）时，拼出来是空 content，
        // 服务端会回 400「all messages must have non-empty content」。就地拦下，别把原始英文甩给用户。
        if (!hasSendableContent(questionForRequest, textDocuments)) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'http',
            status: 400,
            message: 'empty user content',
            localMessage: { key: 'replyNoContent' },
          })
          break
        }
        const messages = toRequestMessages(
          prepared.history,
          questionForRequest,
          prepared.prefix,
          initial.thinking ?? false,
          latestReminder,
          // 压缩过的会话只把最近 CONTEXT_KEEP_ROUNDS 轮发给模型
          getSession(sessionId)?.contextKeepRounds,
          textDocuments,
          // v4-pro 不支持 latest_reminder，改成并进提问文字
          supportsServerTools(initial.model ?? useSettings.getState().model)
        )
        // 自定义模型（中转站）：开启后走 OpenAI 兼容接口。
        // 深度思考、联网搜索是否可用取决于该模型，这里原样把开关传过去，不强行切回官方。
        const relaySettings = useSettings.getState()
        const useRelay =
          relaySettings.relayEnabled &&
          relaySettings.relayBaseUrl.trim() !== '' &&
          relaySettings.relayModel.trim() !== ''
        const events = useRelay
          ? streamRelayMessage({
              baseUrl: relaySettings.relayBaseUrl,
              apiKey: relaySettings.relayApiKey.trim() || relaySettings.apiKey || '',
              model: relaySettings.relayModel.trim(),
              system: buildSystemPrompt(sessionId),
              messages,
              thinking: initial.thinking ?? false,
              search: initial.search ?? false,
              signal: controller.signal,
            })
          : (() => {
              const requestModel = initial.model ?? useSettings.getState().model
              const toolCapable = supportsServerTools(requestModel)
              const wantsSearch = initial.search ?? false
              // v4-pro 带上服务端工具/标题生成会被直接拒，这些能力一并关掉并说明原因
              if (
                !toolCapable &&
                !webDigest &&
                !webNotice &&
                (wantsSearch || hasUrl(prepared.question.content))
              ) {
                showToast({ key: 'modelNoServerTools', type: 'error' })
              }
              // 服务端工具同样吃 32768 的输入预算，带附件时发出去会把大文档一起拒掉
              if (toolCapable && wantsSearch && prepared.question.files.length > 0) {
                showToast({ key: 'searchSkippedWithFiles' })
              }
              return streamMessage(
                useSettings.getState().apiKey ?? '',
                {
                  model: requestModel,
                  system: buildSystemPrompt(sessionId),
                  // 标题：旧接口（额外请求）打开时关闭服务端标题；
                  // 新接口「启用标题生成」只对支持标题的模型、且只在会话第一次请求时带 title.enabled
                  title: (() => {
                    if (useSettings.getState().titleMode === 'extra') {
                      return { enabled: false }
                    }
                    // 只在清单里明确填了该模型时才跳过经典；清单为空 = 不排除任何模型
                    const excluded = useSettings
                      .getState()
                      .titleClassicExcludedModels.split(/\r?\n/)
                      .map((item) => item.trim())
                      .filter(Boolean)
                    return !excluded.includes(requestModel) && isFirstPrompt
                      ? { enabled: true }
                      : undefined
                  })(),
                  messages,
                  thinking: { type: initial.thinking ? 'enabled' : 'disabled' },
                  ...(SAFETY_CHECK ? { safety_check: SAFETY_CHECK } : {}),
                  tools:
                    !useSettings.getState().networkModelEnabled &&
                    toolCapable &&
                    prepared.question.files.length === 0
                      ? serverTools(wantsSearch, prepared.question.content)
                      : [],
                },
                controller.signal
              )
            })()
        const blockIndexes = new Map<number, number>()
        for await (const event of events) {
          if (event.type === 'message_delta' && event.delta.title) {
            serverTitle = event.delta.title
          }
          receivedContent ||= event.type === 'content_block_start'
          reply = applyEvent(reply, event, Date.now(), blockIndexes)
          if (document.visibilityState === 'hidden') {
            flush()
          } else {
            frame ||= requestAnimationFrame(flush)
          }
        }
        reply = settleReply(reply, 'done', Date.now())
        break
      } catch (error) {
        if (controller.signal.aborted) {
          reply = settleReply(reply, 'stopped', Date.now())
          break
        }
        if (preparing) {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'upload',
            message: '',
            localMessage: describeUploadError(error),
            retryable: isRetryableApiError(error),
          })
          break
        }
        // 附件失效：重新补传后重发。收到过内容块（含丢弃的客户端工具）后不自动重发。
        if (
          attempt < FILE_RETRY_LIMIT &&
          !receivedContent &&
          reuploadInvalidatedFiles(sessionId, request, error)
        ) {
          await waitForRetry(attempt, controller.signal)
          if (controller.signal.aborted) {
            reply = settleReply(reply, 'stopped', Date.now())
            break
          }
          continue
        }
        // 图片格式不被服务端接受：把这个会话里的坏图就地转成 JPEG，再重发一次。
        // 判据不能只靠一句固定文案——服务端措辞会变，变了修复流程就完全跳过，
        // 用户会直接看到原始报错。所以「400 + 报错里提到 image + 请求里确实有图」也算命中。
        const requestHasImages =
          request.question.files.some((file) => file.isImage && file.serverId) ||
          request.history.some(
            (message) =>
              message.role === 'user' &&
              message.files.some((file) => file.isImage && file.serverId)
          )
        const imageRejected =
          error instanceof ApiError &&
          error.status === 400 &&
          requestHasImages &&
          (/image/i.test(error.message) || UNSUPPORTED_IMAGE_PATTERN.test(error.message))
        if (!receivedContent && imageRejected) {
          if (attempt < FILE_RETRY_LIMIT && (await repairSessionImages(sessionId))) {
            showToast({ key: 'replyImageRepaired' })
            await waitForRetry(attempt, controller.signal)
            if (controller.signal.aborted) {
              reply = settleReply(reply, 'stopped', Date.now())
              break
            }
            continue
          }
          // 修不好就退一步：问用户要不要把这张图从对话里摘掉后继续
          if (attempt < FILE_RETRY_LIMIT && (await askRemoveUnsupportedImage())) {
            if (controller.signal.aborted) {
              reply = settleReply(reply, 'stopped', Date.now())
              break
            }
            // 优先摘本次请求里真正发出去的图片：服务端刚拒的就是它们
            const sentImageIds = [...request.history, request.question]
              .filter((message): message is UserMessage => message.role === 'user')
              .flatMap((message) => message.files)
              .filter((file) => file.isImage && file.serverId)
              .map((file) => file.id)
            const removed = await removeUnsupportedImages(sessionId, sentImageIds)
            if (removed.length > 0) {
              // request 是本轮的快照，得同步摘掉，否则重试时又把这些图发出去
              const gone = new Set(removed)
              request = {
                ...request,
                question: {
                  ...request.question,
                  files: request.question.files.filter((file) => !gone.has(file.id)),
                },
                history: request.history.map((message) =>
                  message.role === 'user'
                    ? { ...message, files: message.files.filter((file) => !gone.has(file.id)) }
                    : message
                ),
              }
              await waitForRetry(attempt, controller.signal)
              if (controller.signal.aborted) {
                reply = settleReply(reply, 'stopped', Date.now())
                break
              }
              continue
            }
          }
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: { key: 'replyImageUnsupported' },
          })
          break
        }
        if (error instanceof ApiError && error.kind === 'interrupted' && reply.stopReason) {
          // 已收到 message_delta 的结束原因，只是缺了结尾的 message_stop
          reply = settleReply(reply, 'done', Date.now())
        } else if (error instanceof ApiError) {
          // 输入超长（32k 上限）：把两个数字写出来，并问要不要拆成多段发送
          const tooLong = INPUT_TOO_LONG_PATTERN.exec(error.message)
          if (tooLong) {
            const doc = request.question.files.find((item) => !item.isImage)
            // 先试「正文直发」：官方文档支持把正文放进 document 块，不走解析通道的 32768 上限
            if (doc && !textDocuments.has(doc.id)) {
              const blob = await db.loadFile(doc.id)
              const text = blob
                ? await extractDocumentText(
                    new File([blob], doc.name, { type: doc.mimeType || '' })
                  )
                : null
              if (text) {
                if (await askSendAsText(doc.name, String(Math.round(text.length)))) {
                  textDocuments.set(doc.id, text)
                  await waitForRetry(attempt, controller.signal)
                  if (controller.signal.aborted) {
                    reply = settleReply(reply, 'stopped', Date.now())
                    break
                  }
                  continue
                }
              }
            }
            // 不再提供拆分发送：抽不出正文或用户拒绝时，直接落到下面的错误提示
          }
          const missingFeature = MODEL_FEATURE_UNAVAILABLE_PATTERN.exec(error.message)
          reply = settleReply(reply, 'error', Date.now(), {
            kind: error.kind,
            message: error.message,
            status: error.status,
            localMessage: tooLong
              ? {
                  key: 'replyInputTooLong',
                  params: { tokens: tooLong[1], max: tooLong[2] },
                }
              : missingFeature
                ? { key: 'replyModelFeatureUnavailable', params: { model: missingFeature[1] } }
                : error.localMessage,
          })
        } else {
          reply = settleReply(reply, 'error', Date.now(), {
            kind: 'protocol',
            message: error instanceof Error ? error.message : String(error),
          })
        }
        break
      }
    }
  } finally {
    streamFlushes.delete(sessionId)
    cancelAnimationFrame(frame)
    // 实验性：回答结束后用「一问一答」的上下文生成标题，比只看提问准
    if (useSettings.getState().titleMode === 'extra' && !serverTitle) {
      const questionText = request.question.content.trim()
      const answerText = reply.blocks
        .filter((block) => block.type === 'text')
        .map((block) => (block.type === 'text' ? block.text : ''))
        .join('\n')
        .trim()
      if (questionText && answerText) {
        const model = initial.model ?? useSettings.getState().model
        void generateTitle(
          useSettings.getState().apiKey ?? '',
          model,
          `用户问题：${questionText}\n\n助手回答：${answerText.slice(0, 4000)}`
        )
          .then((raw) => {
            // generateTitle 失败时返回 null，保持本地兜底标题不动
            const title = raw ? sanitizeTitle(raw) : ''
            if (!title) {
              return
            }
            updateSession(sessionId, (session) =>
              !session.title || session.title === translate('untitledChat')
                ? { ...session, title }
                : session
            )
            persist(sessionId)
          })
          // 标题失败不打扰用户：保留本地兜底标题即可
          .catch(() => {})
      }
    }
    if (serverTitle) {
      const title = sanitizeTitle(serverTitle)
      if (title) {
        updateSession(sessionId, (session) =>
          !session.title || session.title === translate('untitledChat')
            ? { ...session, title }
            : session
        )
      }
    }
    if (injectedPages && injectedPages.length > 0) {
      reply = attachSearchResult(reply, injectedToolId ?? createId(), injectedPages)
    }
    updateReply(sessionId, reply)
    // 这条回答的 usage 已经是最新，清掉「压缩后先置空」的标记
    updateSession(sessionId, (session) =>
      session.contextUsageCleared ? { ...session, contextUsageCleared: undefined } : session
    )
    set((state) => ({
      streaming: Object.fromEntries(
        Object.entries(state.streaming).filter(([id]) => id !== sessionId)
      ),
    }))
    persist(sessionId)
    // 一条回复结束后算一次上下文用量，达到窗口上限时提示压缩
    promptContextCompress(sessionId)
  }
}
