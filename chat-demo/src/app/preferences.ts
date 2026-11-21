import { FONT_SIZE_SCALES, useSettings, type Locale } from '../services/settings.js'

/** <html lang> 决定 CJK 字形：繁体与日文各用各的，避免被渲染成简体字形 */
const HTML_LANG: Record<Locale, string> = {
  'zh-CN': 'zh-CN',
  'zh-TW': 'zh-Hant-TW',
  'ja-JP': 'ja-JP',
  'en-US': 'en-US',
}

/**
 * 应用显示偏好：界面缩放与页面语言。
 * 缩放作用在根元素上，React portal 挂到 body 的弹窗和菜单也会一起缩放。
 */
const applyPreferences = () => {
  const { fontSize, locale } = useSettings.getState()
  const root = document.documentElement
  const scale = FONT_SIZE_SCALES[fontSize]
  if (scale === 1) {
    root.style.removeProperty('zoom')
  } else {
    root.style.setProperty('zoom', String(scale))
  }
  // 视口单位（vh / innerHeight）是物理像素，不会被 zoom 影响；
  // 布局里靠它们算高度的地方要除以这个倍数，否则会溢出屏幕。
  root.style.setProperty('--ds-zoom', String(scale))
  root.lang = HTML_LANG[locale]
}

/** 首屏渲染前同步一次，之后随设置变化更新 */
export const setupPreferences = () => {
  applyPreferences()
  useSettings.subscribe(applyPreferences)
}
