import clsx from 'clsx'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Tooltip, type TooltipPlacement } from './Tooltip.js'
import styles from './IconButton.module.css'

/**
 * xs 为 28px（图标 16px）、m 为 34px、xl 为 44px（图标 20px）。
 * tooltip 同时作为无障碍名称；没有 tooltip 的按钮通过 aria-label 提供名称
 */
export const IconButton = ({
  icon,
  size = 'xs',
  tone = 'tertiary',
  flat = false,
  tooltip,
  tooltipPlacement,
  className,
  ...props
}: {
  icon: ReactNode
  size?: 'xs' | 'm' | 'xl'
  tone?: 'tertiary' | 'primary'
  /** 不需要点击/悬停背景高光的按钮（如顶栏菜单键） */
  flat?: boolean
  tooltip?: string
  tooltipPlacement?: TooltipPlacement
} & Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'title'>) => {
  const button = (
    <button
      type="button"
      className={clsx(styles.button, styles[size], styles[tone], flat && styles.flat, className)}
      aria-label={tooltip}
      {...props}
      // 触摸点开原生选择器后主动失焦，避免按钮保持高亮
      onPointerUp={(event) => {
        props.onPointerUp?.(event)
        event.currentTarget.blur()
      }}
    >
      {icon}
    </button>
  )
  return tooltip ? (
    <Tooltip content={tooltip} placement={tooltipPlacement}>
      {button}
    </Tooltip>
  ) : (
    button
  )
}
