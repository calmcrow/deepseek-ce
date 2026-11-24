import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { useChatStore } from '../../services/chat/store.js'
import { IconCloseFill14 } from '../base/icons.js'
import styles from './CompressionBar.module.css'

/**
 * 压缩上下文提示：旋转指示器 + 文案。portal 挂到 body 上，
 * 压在设置等弹层之上，所有界面都看得到。
 */
export const CompressionBar = () => {
  const t = useTranslate()
  const [hidden, setHidden] = useState(false)
  const state = useChatStore((store) => store.compressState)

  // 每次新的压缩开始，重新显示
  useEffect(() => {
    setHidden(false)
  }, [state?.sessionId, state?.status])

  if (!state || hidden) {
    return null
  }
  const running = state.status === 'running'
  const failed = state.status === 'failed'
  return createPortal(
    <div className={styles.toast} role="status">
      {running ? <span className={styles.spinner} aria-hidden /> : null}
      <span className={styles.text}>
        {running
          ? t('contextCompressing')
          : failed
            ? t('contextCompressFailed')
            : t('contextCompressDone')}
      </span>
      {running ? null : (
        <button
          type="button"
          className={styles.close}
          aria-label={t('cancel')}
          onClick={() => setHidden(true)}
        >
          <IconCloseFill14 />
        </button>
      )}
    </div>,
    document.body
  )
}
