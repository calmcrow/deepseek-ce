import { create } from 'zustand'
import { useSettings } from '../../services/settings.js'
import { closeMobileSider } from '../sider/mobileSiderState.js'

/** 设置弹窗的分组：通用设置 / 数据管理 */
export type SettingsSection = 'general' | 'data'

/** 设置弹窗：侧边栏底部、没有 API Key 时的操作与 401 提示都可以打开；section 为打开时选中的分组 */
export const useSettingsDialog = create(() => ({
  open: false,
  /** 正在播放退出动画：动画结束才真正卸载 */
  closing: false,
  section: 'general' as SettingsSection,
}))

export const openSettings = (section: SettingsSection) =>
  useSettingsDialog.setState({ open: true, section })

export const closeSettings = () => {
  if (!useSettingsDialog.getState().open) {
    return
  }
  useSettingsDialog.setState({ closing: true })
  // 和设置一起直接收起侧栏，回到主界面
  closeMobileSider()
  window.setTimeout(() => {
    useSettingsDialog.setState({ open: false, closing: false })
  }, 170)
}

/**
 * 发送前的凭证检查。
 *
 * 开了中转站就只认中转站那套配置：地址、模型名非空，Key 可以是中转站 Key，
 * 也可以沿用官方 Key（有些中转站允许）。以前这里只看官方 Key，导致只用中转站
 * 的用户每次发消息都被弹到设置页。
 *
 * 返回 true 表示可以发；false 表示已把设置页打开到该填的位置。
 */
export const ensureApiKey = () => {
  const state = useSettings.getState()
  if (state.relayEnabled) {
    const ready =
      state.relayBaseUrl.trim() !== '' &&
      state.relayModel.trim() !== '' &&
      (state.relayApiKey.trim() !== '' || Boolean(state.apiKey))
    if (ready) {
      return true
    }
    // 中转站的配置在「通用设置 → 更多」
    openSettings('general')
    return false
  }
  if (state.apiKey) {
    return true
  }
  openSettings('data')
  return false
}
