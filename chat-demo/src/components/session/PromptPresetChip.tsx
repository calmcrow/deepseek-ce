import { useTranslate } from '../../i18n/index.js'
import { setSessionPreset, useChatStore } from '../../services/chat/store.js'
import { DEFAULT_PRESET_ID, setDefaultPromptPreset, useSettings } from '../../services/settings.js'
import { Menu } from '../base/Menu.js'
import styles from './MobileHeader.module.css'

/**
 * 顶栏的系统提示词预设切换。
 * 有打开的会话就改这条会话的预设；停在新对话页时改的是"新会话默认预设"。
 */
export const PromptPresetChip = () => {
  const t = useTranslate()
  const activeId = useChatStore((state) => state.activeId)
  const presets = useSettings((state) => state.promptPresets)
  const defaultPresetId = useSettings((state) => state.defaultPromptPresetId)
  const sessionPresetId = useChatStore((state) =>
    state.activeId ? state.sessionCache[state.activeId]?.presetId : undefined
  )

  const currentId = sessionPresetId ?? defaultPresetId
  const nameOf = (id: string, name: string) =>
    id === DEFAULT_PRESET_ID ? t('promptPresetDefault') : name || t('promptPresetUntitled')
  const current = presets.find((preset) => preset.id === currentId)

  const choose = (id: string) => {
    if (activeId) {
      setSessionPreset(activeId, id)
    } else {
      setDefaultPromptPreset(id)
    }
  }

  return (
    <Menu
      options={presets.map((preset) => ({
        key: preset.id,
        label: nameOf(preset.id, preset.name),
        icon: null,
        onSelect: () => choose(preset.id),
      }))}
    >
      {({ toggle }) => (
        <button
          type="button"
          className={styles.presetChip}
          aria-label={t('settingsSystemPrompt')}
          onClick={toggle}
        >
          {nameOf(currentId, current?.name ?? '')}
        </button>
      )}
    </Menu>
  )
}
