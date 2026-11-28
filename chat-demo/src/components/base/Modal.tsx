import clsx from 'clsx'
import { useCallback, useEffect, useId, useRef, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseOutline16 } from './icons.js'
import { IconButton } from './IconButton.js'
import styles from './Modal.module.css'

/** 当前打开的弹窗，后打开的在末尾；叠放时 Esc 只关闭最上层 */
const openModals: object[] = []

/** 遮罩 + 居中卡片，Esc / 点遮罩关闭 */
export const Modal = ({
  title,
  children,
  footer,
  closable = false,
  className,
  mainClassName,
  style,
  closing = false,
  onClose,
}: {
  title: ReactNode
  children?: ReactNode
  footer?: ReactNode
  /** 标题栏右侧显示关闭按钮 */
  closable?: boolean
  className?: string
  /** 内容区的 class */
  mainClassName?: string
  /** 内容区的内联样式（CSS 构建可能丢规则时用） */
  style?: React.CSSProperties
  /** 正在关闭：遮罩和内容一起渐隐 */
  closing?: boolean
  onClose: () => void
}) => {
  const t = useTranslate()
  const titleId = useId()
  /** 关闭时先播放滑出动画，结束再真正卸载 */
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose
  const close = useCallback(() => {
    onCloseRef.current()
  }, [])
  // 供系统返回键调用：走同一个关闭动画
  useEffect(() => {
    const scope = window as unknown as { __dsCloseModal?: () => void }
    const previous = scope.__dsCloseModal
    scope.__dsCloseModal = () => {
      document.activeElement instanceof HTMLElement && document.activeElement.blur()
      close()
    }
    return () => {
      scope.__dsCloseModal = previous
    }
  }, [close])

  useEffect(() => {
    const token = {}
    openModals.push(token)
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openModals.at(-1) === token) {
        close()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => {
      openModals.splice(openModals.indexOf(token), 1)
      document.removeEventListener('keydown', onKeyDown)
    }
  }, [])

  return createPortal(
    <div
      className={styles.overlay}
      style={{
        opacity: closing ? 0 : 1,
        transition: 'opacity 0.15s ease',
      }}
      onMouseDown={(event) => event.target === event.currentTarget && close()}
    >
      <div
        className={clsx(styles.content, className)}
        style={style}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
      >
        <div className={styles.header}>
          <div id={titleId} className={styles.title}>
            {title}
          </div>
          {closable ? (
            <IconButton
              className={styles.close}
              tone="primary"
              icon={<IconCloseOutline16 />}
              aria-label={t('close')}
              onClick={close}
            />
          ) : null}
        </div>
        {children ? <div className={clsx(styles.main, mainClassName)}>{children}</div> : null}
        {footer ? <div className={styles.footer}>{footer}</div> : null}
      </div>
    </div>,
    document.body
  )
}
