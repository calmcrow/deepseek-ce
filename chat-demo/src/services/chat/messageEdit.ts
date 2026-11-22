import { create } from 'zustand'
import type { FileAttachment } from './types.js'
import { getDraft, setDraftText } from './drafts.js'

/** 正在编辑的消息：消息 id、原附件、进入编辑前输入框里的文字（取消时还原） */
type EditTarget = { messageId: string; previousText: string; files: FileAttachment[] }

export const useMessageEdits = create<{ targets: Map<string, EditTarget> }>(() => ({
  targets: new Map(),
}))

/** 把消息正文搬到底部输入框，并记下原来的草稿文字；附件沿用原消息，可逐个移除 */
export const beginEditMessage = (
  sessionId: string,
  messageId: string,
  content: string,
  files: FileAttachment[]
) => {
  const previousText = getDraft(sessionId).text
  useMessageEdits.setState((state) => {
    const targets = new Map(state.targets)
    targets.set(sessionId, { messageId, previousText, files })
    return { targets }
  })
  setDraftText(sessionId, content)
}

/** 从编辑中的附件里移除一个；提交时按剩余附件重建这条提问 */
export const removeEditFile = (sessionId: string, fileId: string) => {
  useMessageEdits.setState((state) => {
    const target = state.targets.get(sessionId)
    if (!target) {
      return state
    }
    const targets = new Map(state.targets)
    targets.set(sessionId, { ...target, files: target.files.filter((file) => file.id !== fileId) })
    return { targets }
  })
}

/** 提交成功后清空输入框；取消时还原进入编辑前的草稿文字 */
export const endEditMessage = (sessionId: string, restore: boolean) => {
  const target = useMessageEdits.getState().targets.get(sessionId)
  useMessageEdits.setState((state) => {
    const targets = new Map(state.targets)
    targets.delete(sessionId)
    return { targets }
  })
  setDraftText(sessionId, restore ? (target?.previousText ?? '') : '')
}
