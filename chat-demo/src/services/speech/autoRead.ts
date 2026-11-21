import { getVisibleMessages } from '../chat/branches.js'
import { getReplyText } from '../chat/reply.js'
import { useChatStore } from '../chat/store.js'
import type { AssistantMessage } from '../chat/types.js'
import { useSettings } from '../settings.js'
import { describeReadAloudError, startReadAloud, stopReadAloud } from './readAloud.js'
import { showToast } from '../../components/base/toastState.js'

/** 上一次观察到的「正在生成」的会话集合，用于识别哪一条刚刚生成完 */
let streamingSessions = new Set<string>()

/** 当前分支上最后一条回复 */
const lastReply = (sessionId: string): AssistantMessage | null => {
  const session = useChatStore.getState().sessionCache[sessionId]
  if (!session) {
    return null
  }
  const last = getVisibleMessages(session).at(-1)
  return last?.role === 'assistant' ? last : null
}

/**
 * 自动朗读：只在「本次刚生成完的那条回复」上触发。
 * 用会话集合的前后差异判断完成时机，所以切换会话、浏览历史都不会误读。
 */
const syncAutoRead = () => {
  const state = useChatStore.getState()
  const current = new Set(Object.keys(state.streaming))
  const finished = [...streamingSessions].filter((id) => !current.has(id))
  streamingSessions = current
  if (finished.length === 0) {
    return
  }
  // 只处理刚刚结束、且用户还停在这个会话上的那条
  const sessionId = finished.find((id) => id === state.activeId)
  if (!sessionId || !useSettings.getState().autoReadAloud) {
    return
  }
  const reply = lastReply(sessionId)
  if (!reply || reply.status !== 'done') {
    return
  }
  const text = getReplyText(reply).trim()
  if (!text) {
    return
  }
  startReadAloud(reply.id, text, (error) => showToast(describeReadAloudError(error)))
}

/** 挂上自动朗读：跟随生成状态触发，关掉开关时停止正在读的内容 */
export const setupAutoRead = () => {
  streamingSessions = new Set(Object.keys(useChatStore.getState().streaming))
  useChatStore.subscribe(syncAutoRead)
  useSettings.subscribe((state, previous) => {
    if (previous.autoReadAloud && !state.autoReadAloud) {
      stopReadAloud()
    }
  })
}
