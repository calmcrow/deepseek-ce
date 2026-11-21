import clsx from 'clsx'
import { useTranslate } from '../../i18n/index.js'
import type { SessionContextUsage } from '../../services/chat/types.js'
import { getContextWindow } from '../../services/settings.js'
import styles from './ContextUsageBar.module.css'

/** 用量分段的两个阈值：前 30% 绿色，30%~80% 黄色，80% 之后红色 */
const AMBER_FROM = 0.3
const RED_FROM = 0.8

/** token 数的紧凑写法：1_200_000 → 1.2M，880_000 → 880K，不到 1K 直接给原数 */
const formatTokens = (value: number): string => {
  const tokens = Math.max(Math.round(value), 0)
  const thousands = Math.round(tokens / 1000)
  // 四舍五入后到 1000K 的按 M 写，避免出现「1000K」
  if (thousands >= 1000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  }
  return thousands >= 1 ? `${thousands}K` : String(tokens)
}

/**
 * 侧栏「⋯」菜单顶部的上下文用量条：一条横向进度条 + 一行小字，纯展示、不可点击。
 * 已用 token 取当前分支最后一条回答的 usage 四项之和；拿不到用量（如刚导入的会话）时显示「—」，
 * 分母是这一轮用的模型（缺省用当前选择的模型）的上下文窗口，接口没给窗口时兜底 1M。
 */
export const ContextUsageBar = ({ usage }: { usage?: SessionContextUsage }) => {
  const t = useTranslate()
  const contextWindow = getContextWindow(usage?.model)
  const used = usage?.tokens
  // 已用比例；超过 100% 时只把进度条截到满格，百分比与「剩余」照实显示
  const ratio = used === undefined ? 0 : used / contextWindow
  const percent = Math.round(ratio * 100)
  const remaining = used === undefined ? 0 : Math.max(contextWindow - used, 0)
  const tone =
    used === undefined
      ? styles.unknown
      : ratio < AMBER_FROM
        ? styles.green
        : ratio < RED_FROM
          ? styles.amber
          : styles.red

  return (
    <div className={styles.usage}>
      <div className={styles.track} role="presentation">
        <div
          className={clsx(styles.fill, tone)}
          style={{ width: `${(Math.min(Math.max(ratio, 0), 1) * 100).toFixed(2)}%` }}
        />
      </div>
      <div className={styles.label}>
        {used === undefined
          ? t('contextUsageUnknown')
          : t('contextUsageLabel', { percent, remaining: formatTokens(remaining) })}
      </div>
    </div>
  )
}
