import { useTranslate } from '../../i18n/index.js'
import { setAutoReadAloud, useSettings } from '../../services/settings.js'
import { stopReadAloud } from '../../services/speech/readAloud.js'
import { IconVolumeOffOutline20, IconVolumeOnOutline20 } from '../base/icons.js'
import { IconButton } from '../base/IconButton.js'
import { showToast } from '../base/toastState.js'

/**
 * 自动朗读开关：开启后每条回答生成完自动朗读，关闭后不再朗读。
 * 顶部栏和设置里共用这一个按钮。
 */
export const AutoReadToggle = ({ size = 'xl' }: { size?: 'xs' | 'm' | 'xl' }) => {
  const t = useTranslate()
  const autoRead = useSettings((state) => state.autoReadAloud)
  return (
    <IconButton
      size={size}
      tone="primary"
      icon={autoRead ? <IconVolumeOnOutline20 /> : <IconVolumeOffOutline20 />}
      tooltip={autoRead ? t('autoReadTurnOff') : t('autoReadTurnOn')}
      tooltipPlacement="bottom"
      onClick={() => {
        if (autoRead) {
          stopReadAloud()
        }
        setAutoReadAloud(!autoRead)
        showToast({ key: autoRead ? 'autoReadDisabledToast' : 'autoReadEnabledToast' })
      }}
    />
  )
}
