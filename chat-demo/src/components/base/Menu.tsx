import clsx from 'clsx'
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { useAnchoredPosition, useDismiss } from './anchored.js'
import styles from './Menu.module.css'

export type MenuOption = {
  key: string
  label: string
  icon: ReactNode
  danger?: boolean
  onSelect: () => void
}

/** 点击触发，向下展开；点外部或 Esc 关闭 */
export const Menu = ({
  options,
  header,
  onClose,
  anchorEl,
  align = 'start',
  children,
}: {
  options: MenuOption[]
  /** 选项上方的附加内容（如上下文用量条）：只展示，不参与点击选中 */
  header?: ReactNode
  /** 菜单关闭时通知调用方（点击外部、Esc、选中某项都会触发） */
  onClose?: () => void
  /** 用外部元素定位：不渲染可见的触发按钮时，把整个列表项当锚点 */
  anchorEl?: HTMLElement | null
  /** 相对锚点的水平对齐：'end' 时菜单贴在锚点右侧 */
  align?: 'start' | 'center' | 'end'
  children: (props: { open: boolean; toggle: () => void }) => ReactNode
}) => {
  const [open, setOpen] = useState(false)
  /** 关闭时先播放淡出，动画结束再真正移除 */
  const [closing, setClosing] = useState(false)
  const close = () => {
    if (!open || closing) {
      return
    }
    setClosing(true)
    // 通知调用方要在动画开始时就发，这样外部高亮和菜单同步收起
    onClose?.()
    window.setTimeout(() => {
      setClosing(false)
      setOpen(false)
    }, 180)
  }
  // 左侧对齐并再左移 5px，让菜单文字与触发元素图标对齐
  const { anchorRef, floatingRef, position } = useAnchoredPosition<HTMLSpanElement, HTMLDivElement>(
    open,
    { align, alignOffset: align === 'end' ? 5 : -5, offset: 4 }
  )
  useDismiss(open, [anchorRef, floatingRef], close)

  if (anchorEl) {
    anchorRef.current = anchorEl
  }

  // 菜单打开时锁住侧栏列表滚动，避免长按后手指滑动把列表带着滚
  useEffect(() => {
    if (!open) {
      return
    }
    document.body.classList.add('dsh-menu-open')
    return () => {
      document.body.classList.remove('dsh-menu-open')
    }
  }, [open])

  return (
    <>
      <span ref={anchorEl ? undefined : anchorRef} className={styles.anchor}>
        {children({ open, toggle: () => setOpen((value) => !value) })}
      </span>
      {open
        ? createPortal(
            <>
              {/* 透明遮罩：点外部只关菜单，点击不会落到下面的列表项上 */}
              <div
                className={styles.backdrop}
                onPointerDown={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  close()
                }}
              />
              <div
                ref={floatingRef}
                className={clsx(styles.menu, closing && styles.menuClosing)}
                style={position ?? undefined}
                role="menu"
              >
              {header ? <div className={styles.header}>{header}</div> : null}
              {options.map((option) => (
                <div
                  key={option.key}
                  role="menuitem"
                  className={clsx(styles.option, option.danger && styles.danger)}
                  onClick={(event) => {
                    // 别让这次点击穿透到下面的列表项，否则会顺手把会话打开
                    event.stopPropagation()
                    event.preventDefault()
                    close()
                    option.onSelect()
                  }}
                >
                  <span className={styles.icon}>{option.icon}</span>
                  {option.label}
                </div>
              ))}
              </div>
            </>,
            document.body
          )
        : null}
    </>
  )
}
