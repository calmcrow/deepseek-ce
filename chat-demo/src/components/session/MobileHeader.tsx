import { IconMenuOutline20, IconNewChatOutline20 } from '../base/icons.js'
import { useTranslate } from '../../i18n/index.js'
import { newChat } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import { IconButton } from '../base/IconButton.js'
import { AutoReadToggle } from '../speech/AutoReadToggle.js'
import { openMobileSider } from '../sider/mobileSiderState.js'
import { PromptPresetChip } from './PromptPresetChip.js'
import styles from './MobileHeader.module.css'

/** 移动端顶栏：菜单、标题、提示词预设、自动朗读开关、开启新对话 */
export const MobileHeader = ({ title }: { title?: string }) => {
  const t = useTranslate()
  const buttonMode = useSettings((state) => state.siderButtonMode)
  return (
    <div className={styles.header}>
      {buttonMode ? (
        <IconButton
          size="xl"
          tone="primary"
          icon={<IconMenuOutline20 />}
          aria-label={t('expandSiderbarButton')}
          onClick={openMobileSider}
        />
      ) : null}
      <div className={styles.title}>{title ?? ''}</div>
      <PromptPresetChip />
      <AutoReadToggle />
      <IconButton
        size="xl"
        tone="primary"
        icon={<IconNewChatOutline20 />}
        aria-label={t('newChat')}
        onClick={newChat}
      />
    </div>
  )
}
