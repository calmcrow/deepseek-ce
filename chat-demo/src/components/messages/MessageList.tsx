import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useIsMobile } from '../../app/viewport.js'
import { useTranslate } from '../../i18n/index.js'
import {
  buildMessageVersions,
  getVisibleMessages,
  type MessageVersions,
} from '../../services/chat/branches.js'
import { selectMessageVersion } from '../../services/chat/store.js'
import { clearJump, useJumpTarget } from '../../services/chat/searchState.js'
import type { Session } from '../../services/chat/types.js'
import { closeSearchPanel } from '../search/searchPanelState.js'
import { AssistantMessage } from './AssistantMessage.js'
import { ScrollToBottomContext } from './scrollContext.js'
import { UserMessage } from './UserMessage.js'
import type { Message } from '../../services/chat/types.js'

/**
 * 会话共用可重试的附件上传失败入口，覆盖当前提问与历史消息中的附件。
 * 点击后按失败的回答重新补传附件并请求。
 */
const getUploadRetryId = (messages: Message[], streaming: boolean) => {
  const last = messages.at(-1)
  return !streaming &&
    last?.role === 'assistant' &&
    last.status === 'error' &&
    last.error?.kind === 'upload' &&
    last.error.retryable
    ? last.id
    : null
}
import styles from './MessageList.module.css'

/** 距底部小于该值时视为在底部，流式内容增长时跟随 */
const STICKY_THRESHOLD = 40
/**
 * 首屏只渲染当前分支最近这么多条消息。整条会话一次渲染的耗时随消息数线性增长
 *（实测 800 条约 0.6 秒，其中 Markdown 解析约占四成），更早的消息由顶部按钮按需追加。
 */
const INITIAL_WINDOW = 40
/** 每次「显示更早的消息」追加的条数 */
const EARLIER_STEP = 100
/** 跳转高光在输入框卡片中线以上这么多像素开始渐隐，中线以下不再显示高光 */
const JUMP_FADE = 24
const EMPTY_VERSIONS: MessageVersions = { ids: [], index: -1 }

export const MessageList = ({
  session,
  streaming,
  footer,
}: {
  session: Session
  streaming: boolean
  footer: React.ReactNode
}) => {
  const t = useTranslate()
  const isMobile = useIsMobile()
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const highlightRef = useRef<HTMLDivElement>(null)
  const maskRef = useRef<HTMLDivElement>(null)
  const stickyRef = useRef(true)
  const scrollTopRef = useRef(0)
  const restoreScrollRef = useRef<{ messageId: string; top: number } | null>(null)
  /** 追加更早的消息前，当前视口距底部的高度；提交后按新高度回填滚动位置 */
  const growRef = useRef<number | null>(null)
  const messages = getVisibleMessages(session)
  const [windowSize, setWindowSize] = useState(INITIAL_WINDOW)
  // 切换会话时回到首屏窗口：在渲染期同步更新，避免多用一帧渲染整条会话。
  const windowSessionRef = useRef(session.id)
  if (windowSessionRef.current !== session.id) {
    windowSessionRef.current = session.id
    setWindowSize(INITIAL_WINDOW)
  }
  const hiddenCount = Math.max(messages.length - windowSize, 0)
  const shown = hiddenCount > 0 ? messages.slice(hiddenCount) : messages
  const [previousVersions, setPreviousVersions] = useState(() =>
    buildMessageVersions(session, new Map())
  )
  const versions = useMemo(
    () => buildMessageVersions(session, previousVersions),
    [session, previousVersions]
  )
  if (versions !== previousVersions) {
    setPreviousVersions(versions)
  }
  const lastMessageId = messages.at(-1)?.id
  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el && stickyRef.current) {
      el.scrollTop = el.scrollHeight
      scrollTopRef.current = el.scrollTop
    }
  }, [])

  // 追加更早的消息后内容变高，按增量回填滚动位置，视觉上停在原来的位置。
  useLayoutEffect(() => {
    const distanceFromBottom = growRef.current
    const scroll = scrollRef.current
    if (distanceFromBottom === null || !scroll) {
      return
    }
    growRef.current = null
    scroll.scrollTop = scroll.scrollHeight - distanceFromBottom
    scrollTopRef.current = scroll.scrollTop
  }, [windowSize])

  const showEarlier = useCallback(() => {
    const scroll = scrollRef.current
    growRef.current = scroll ? scroll.scrollHeight - scroll.scrollTop : null
    setWindowSize((size) => size + EARLIER_STEP)
  }, [])

  // 内容、键盘和输入框高度变化时，继续遵循当前跟随状态。
  useLayoutEffect(() => {
    const content = contentRef.current
    const scroll = scrollRef.current
    if (!content || !scroll) {
      return
    }
    const observer = new ResizeObserver(scrollToBottom)
    observer.observe(content)
    observer.observe(scroll)
    return () => observer.disconnect()
  }, [isMobile, scrollToBottom])

  // 切换会话时回到首屏并滚到底；版本切换时恢复选择器位置。
  useLayoutEffect(() => {
    const anchor = restoreScrollRef.current
    const scroll = scrollRef.current
    if (anchor && scroll) {
      const switcher = scroll.querySelector<HTMLElement>(
        `[data-message-version="${CSS.escape(anchor.messageId)}"]`
      )
      if (switcher) {
        scroll.scrollTop += switcher.getBoundingClientRect().top - anchor.top
      }
      restoreScrollRef.current = null
      return
    }
    stickyRef.current = true
    scrollToBottom()
  }, [session.id, scrollToBottom])

  // 内容增长时只在跟随底部的情况下贴底：跳转或上滑之后不能把位置拉回去。
  useLayoutEffect(() => {
    if (stickyRef.current) {
      scrollToBottom()
    }
  }, [lastMessageId, scrollToBottom])

  useEffect(closeSearchPanel, [session.id, lastMessageId])

  const selectVersion = useCallback(
    (messageId: string, anchorTop: number) => {
      if (streaming) {
        return
      }
      restoreScrollRef.current = { messageId, top: anchorTop }
      stickyRef.current = false
      closeSearchPanel()
      selectMessageVersion(session.id, messageId)
    },
    [session.id, streaming]
  )

  // 跨移动端断点时切换滚动层，并保持输入框及当前阅读位置。
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) {
      return
    }
    if (stickyRef.current) {
      scrollToBottom()
    } else {
      el.scrollTop = scrollTopRef.current
    }
    const onScroll = () => {
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < STICKY_THRESHOLD
      // 仅在用户向上滚动时停止跟随底部，布局或内容增高时保持跟随状态。
      if (nearBottom) {
        stickyRef.current = true
      } else if (el.scrollTop < scrollTopRef.current) {
        stickyRef.current = false
      }
      scrollTopRef.current = el.scrollTop
    }
    el.addEventListener('scroll', onScroll, { passive: true })
    return () => el.removeEventListener('scroll', onScroll)
  }, [isMobile, scrollToBottom])

  // 搜索结果点击后定位到具体消息：目标不在当前窗口时先展开，再滚动并短暂高亮
  const jumpTarget = useJumpTarget((state) => state.target)
  useEffect(() => {
    if (!jumpTarget || jumpTarget.sessionId !== session.id) {
      return
    }
    const container = contentRef.current
    if (!container) {
      return
    }
    // 滚动定位到这一轮的用户提问：提问显示在屏幕上方，上面留一点余量
    const hitIndex = messages.findIndex((message) => message.id === jumpTarget.messageId)
    let anchorId = jumpTarget.messageId
    // 高光落在「回答」上：命中的若是提问，就取它后面那条回答
    let highlightId = jumpTarget.messageId
    if (hitIndex >= 0) {
      if (messages[hitIndex].role === 'assistant') {
        for (let index = hitIndex - 1; index >= 0; index -= 1) {
          if (messages[index].role === 'user') {
            anchorId = messages[index].id
            break
          }
        }
      } else {
        for (let index = hitIndex + 1; index < messages.length; index += 1) {
          if (messages[index].role === 'assistant') {
            highlightId = messages[index].id
            break
          }
        }
      }
    }
    const anchor = container.querySelector<HTMLElement>(`[data-message-id="${anchorId}"]`)
    const target = container.querySelector<HTMLElement>(`[data-message-id="${highlightId}"]`)
    if (!anchor) {
      if (hiddenCount > 0) {
        // 只展开到能覆盖这一轮提问为止，长对话不要一次性渲染全部消息
        const hitIndex = messages.findIndex((message) => message.id === jumpTarget.messageId)
        let anchorIndex = hitIndex
        if (hitIndex >= 0 && messages[hitIndex].role === 'assistant') {
          for (let index = hitIndex - 1; index >= 0; index -= 1) {
            if (messages[index].role === 'user') {
              anchorIndex = index
              break
            }
          }
        }
        if (anchorIndex >= 0) {
          const needed = messages.length - anchorIndex + 5
          setWindowSize((size) => Math.max(size, Math.min(messages.length, needed)))
        }
      }
      return
    }
    stickyRef.current = false
    // 只改垂直滚动：scrollIntoView 默认还会处理横向，长消息/全宽高光可能带动横向滚动
    const scroller = scrollRef.current
    if (scroller) {
      const offset = anchor.getBoundingClientRect().top - scroller.getBoundingClientRect().top
      scroller.scrollTop = Math.max(0, scroller.scrollTop + offset - 24)
    }
    // 高光以命中消息的范围为界限，再往下蔓延到输入框
    const overlay = highlightRef.current
    clearJump()
    if (!overlay) {
      return
    }
    const placeOverlay = () => {
      // 相对滚动内容定位，这样高光会跟着消息一起滚
      const content = contentRef.current
      const box = content?.getBoundingClientRect()
      if (!box) {
        return
      }
      // 高光只覆盖命中消息的文字区域；蒙版固定在屏幕上，负责输入框附近的亮度
      const footerEl = content?.parentElement?.parentElement?.lastElementChild
      const cardEl = footerEl?.firstElementChild
      const mask = maskRef.current
      if (target) {
        const rect = target.getBoundingClientRect()
        overlay.style.top = `${Math.max(0, rect.top - box.top)}px`
        overlay.style.height = `${Math.max(60, rect.height)}px`
        overlay.style.bottom = 'auto'
        if (mask) {
          const endEl = cardEl instanceof HTMLElement ? cardEl : footerEl
          if (endEl instanceof HTMLElement) {
            const endRect = endEl.getBoundingClientRect()
            const cardMid = endRect.top + endRect.height / 2
            mask.style.height = `${Math.max(0, window.innerHeight - cardMid + JUMP_FADE)}px`
          }
        }
      } else {
        // 目标消息还没渲染出来：先不亮，避免整屏泛白
        overlay.style.height = '0px'
        if (mask) {
          mask.style.height = '0px'
        }
      }
      overlay.style.setProperty('--jump-fade', `${JUMP_FADE}px`)
    }
    // 高光期间持续跟踪目标位置：图片、公式等异步排版后高光不会停在旧位置
    let raf = 0
    const track = () => {
      placeOverlay()
      raf = window.requestAnimationFrame(track)
    }
    track()
    overlay.classList.remove(styles.jumpOverlayActive)
    void overlay.offsetWidth
    overlay.classList.add(styles.jumpOverlayActive)
    window.setTimeout(() => {
      window.cancelAnimationFrame(raf)
      overlay.classList.remove(styles.jumpOverlayActive)
    }, 5000)
    // 会话是异步加载的：消息还没渲染出来时不要清除请求，等下一次渲染再试
  }, [jumpTarget, session.id, hiddenCount, messages])

  const lastIndex = shown.length - 1
  const uploadRetryId = getUploadRetryId(messages, streaming)
  return (
    <ScrollToBottomContext.Provider value={scrollToBottom}>
      <div ref={isMobile ? undefined : scrollRef} className={styles.container}>
        <div ref={maskRef} className={styles.jumpMask} aria-hidden />
        <div ref={isMobile ? scrollRef : undefined} className={styles.scroll}>
          <div ref={contentRef} className={styles.column}>
            <div ref={highlightRef} className={styles.jumpOverlay} aria-hidden />
            {hiddenCount > 0 ? (
              <button type="button" className={styles.earlier} onClick={showEarlier}>
                {t('showEarlierMessages', { count: Math.min(EARLIER_STEP, hiddenCount) })}
              </button>
            ) : null}
            {shown.map((message, index) =>
              message.role === 'user' ? (
                <UserMessage
                  key={message.id}
                  sessionId={session.id}
                  message={message}
                  retryUploadId={uploadRetryId}
                  isFirst={index === 0 && hiddenCount === 0}
                  isLast={index === lastIndex || index === lastIndex - 1}
                  busy={streaming}
                  versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                  onSelectVersion={selectVersion}
                />
              ) : (
                <Fragment key={message.id}>
                  <AssistantMessage
                    sessionId={session.id}
                    message={message}
                    isLast={index === lastIndex}
                    streaming={streaming && index === lastIndex}
                    busy={streaming}
                    versions={versions.get(message.id) ?? EMPTY_VERSIONS}
                    onSelectVersion={selectVersion}
                  />
                </Fragment>
              )
            )}
          </div>
        </div>
        {footer}
      </div>
    </ScrollToBottomContext.Provider>
  )
}
