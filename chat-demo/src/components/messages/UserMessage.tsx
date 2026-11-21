import { useTranslate } from '../../i18n/index.js'
import clsx from 'clsx'
import { memo, useCallback, useLayoutEffect, useRef, useState } from 'react'
import { IconChevronDownOutline14, IconEditOutline16 } from '../base/icons.js'
import { editMessage, retryUpload } from '../../services/chat/store.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import type { UserMessage as UserMessageType } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { ensureApiKey } from '../settings/settingsDialogState.js'
import {
  BranchSwitcher,
  type MessageVersions,
  type SelectMessageVersion,
} from './BranchSwitcher.js'
import { MessageFile } from './MessageFile.js'
import { CopyButton } from './CopyButton.js'
import styles from './UserMessage.module.css'

/** 超过这个高度才折叠；只有几行的短消息保持原样 */
const COLLAPSE_HEIGHT = 240

/**
 * 用户消息正文：太长时截断并给一个展开按钮（和官方客户端一致）。
 * 高度用 scrollHeight 量，短内容不会出现按钮。
 */
const MessageText = ({ text }: { text: string }) => {
  const t = useTranslate()
  const textRef = useRef<HTMLDivElement>(null)
  const [expanded, setExpanded] = useState(false)
  const [overflowing, setOverflowing] = useState(false)

  const measure = useCallback(() => {
    const element = textRef.current
    if (!element) {
      return
    }
    // 展开状态下量不到真实高度（已撑开），所以只在收起时判断
    setOverflowing(element.scrollHeight > COLLAPSE_HEIGHT + 8)
  }, [])

  useLayoutEffect(() => {
    if (!expanded) {
      measure()
    }
  }, [text, expanded, measure])

  const clamped = overflowing && !expanded
  return (
    <div className={styles.bubble}>
      <div
        ref={textRef}
        className={clamped ? styles.clamped : undefined}
        style={clamped ? { maxHeight: COLLAPSE_HEIGHT } : undefined}
      >
        {text}
      </div>
      {overflowing ? (
        <button
          type="button"
          className={clsx(styles.toggle, expanded && styles.toggleExpanded)}
          aria-label={t(expanded ? 'collapseMessage' : 'expandMessage')}
          title={t(expanded ? 'collapseMessage' : 'expandMessage')}
          onClick={() => setExpanded((value) => !value)}
        >
          <IconChevronDownOutline14 />
        </button>
      ) : null}
    </div>
  )
}

export const UserMessage = memo(function UserMessage({
  sessionId,
  message,
  retryUploadId,
  isFirst,
  isLast,
  busy,
  versions,
  onSelectVersion,
}: {
  sessionId: string
  message: UserMessageType
  /** 回答因补传附件失败可重试时为该回答 id */
  retryUploadId: string | null
  isFirst: boolean
  isLast: boolean
  busy: boolean
  versions: MessageVersions
  onSelectVersion: SelectMessageVersion
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(message.content)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const canSend = !busy && (draft.trim() !== '' || message.files.length > 0)

  useLayoutEffect(() => {
    const textarea = textareaRef.current
    if (editing && textarea) {
      textarea.style.height = 'auto'
      textarea.style.height = `${Math.min(textarea.scrollHeight, 202)}px`
    }
  }, [editing, draft])

  const sendEdit = () => {
    if (canSend && ensureApiKey() && editMessage(sessionId, message.id, draft.trim())) {
      stopReadAloud()
      setEditing(false)
    }
  }

  return (
    <div className={clsx(styles.container, isFirst && styles.isFirst)}>
      {message.files.length > 0 ? (
        <div
          className={clsx(
            styles.files,
            message.files.some((file) => !file.isImage) && styles.filesWithDocuments
          )}
        >
          {message.files.map((file) => (
            <MessageFile
              key={file.id}
              file={file}
              onRetry={retryUploadId ? () => retryUpload(sessionId, retryUploadId) : null}
            />
          ))}
        </div>
      ) : null}
      {editing ? (
        <div className={styles.editor}>
          <textarea
            ref={textareaRef}
            className={styles.textarea}
            aria-label={t('editMessage')}
            autoFocus
            rows={1}
            value={draft}
            disabled={busy}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return
              }
              if (event.key === 'Escape') {
                setEditing(false)
              } else if (
                event.key === 'Enter' &&
                (event.ctrlKey || event.metaKey) &&
                !event.nativeEvent.isComposing
              ) {
                // 和主输入框一致：回车只换行，Ctrl/⌘+Enter 才提交
                event.preventDefault()
                sendEdit()
              }
            }}
          />
          <div className={styles.editorActions}>
            <Button size="s" variant="outlined" onClick={() => setEditing(false)}>
              {t('cancel')}
            </Button>
            <Button size="s" disabled={!canSend} onClick={sendEdit}>
              {t('send')}
            </Button>
          </div>
        </div>
      ) : (
        <>
          {message.content ? <MessageText text={message.content} /> : null}
          <div className={styles.bottom}>
            <div className={clsx(styles.actions, isLast && styles.alwaysShow)}>
              {message.content ? <CopyButton text={message.content} /> : null}
              <IconButton
                icon={<IconEditOutline16 />}
                tooltip={t('editMessage')}
                tooltipPlacement="bottom"
                disabled={busy}
                onClick={() => {
                  setDraft(message.content)
                  setEditing(true)
                }}
              />
            </div>
            <BranchSwitcher versions={versions} disabled={busy} onSelect={onSelectVersion} />
          </div>
        </>
      )}
    </div>
  )
})
