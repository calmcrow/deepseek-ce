import { createRoot, type Root } from 'react-dom/client'
import { useTranslate } from '../../i18n/index.js'
import { Button } from './Button.js'
import { Modal } from './Modal.js'
import styles from './ContextCompressDialog.module.css'

/**
 * 弹窗宿主：`main.tsx` / `App.tsx` 里没有可以插入的挂载点，所以这里按需把弹窗挂到 body 上，
 * 和轻提示一样不挑宿主；弹窗自己 portal 到 body，宿主节点只作为 React 根，不参与布局。
 */
let host: HTMLElement | null = null
let root: Root | null = null

/** 关掉弹窗：根节点渲染成空，下次提示时复用同一个根 */
const close = () => root?.render(null)

const ContextCompressDialog = ({ onCompress }: { onCompress: () => void }) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('contextLimitTitle')}
      onClose={close}
      footer={
        <>
          <Button variant="outlined" onClick={close}>
            {t('contextLimitDismiss')}
          </Button>
          <Button
            onClick={() => {
              close()
              onCompress()
            }}
          >
            {t('contextLimitCompress')}
          </Button>
        </>
      }
    >
      <p className={styles.ask}>{t('contextLimitDescription')}</p>
      <p className={styles.note}>{t('contextLimitNote')}</p>
    </Modal>
  )
}

/** 提示上下文已用满：只展示一次，用户选「压缩上下文」时执行传进来的压缩动作 */
export const showContextCompressPrompt = (onCompress: () => void) => {
  if (!root) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  root.render(<ContextCompressDialog onCompress={onCompress} />)
}
