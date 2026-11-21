import { createRoot, type Root } from 'react-dom/client'
import { useTranslate } from '../../i18n/index.js'
import { Button } from './Button.js'
import { Modal } from './Modal.js'
import styles from './ContextCompressDialog.module.css'

/**
 * 弹窗宿主：和上下文压缩提示一样按需挂到 body 上，不依赖 App 里有没有挂载点。
 * 这里是「确认框」，所以用 Promise 把用户的选择交回调用方。
 */
let host: HTMLElement | null = null
let root: Root | null = null
let settle: ((value: boolean) => void) | null = null

const finish = (value: boolean) => {
  const resolve = settle
  settle = null
  root?.render(null)
  resolve?.(value)
}

const UnsupportedImageDialog = () => {
  const t = useTranslate()
  return (
    <Modal
      title={t('replyImageRemoveTitle')}
      onClose={() => finish(false)}
      footer={
        <>
          <Button variant="outlined" onClick={() => finish(false)}>
            {t('cancel')}
          </Button>
          <Button variant="danger" onClick={() => finish(true)}>
            {t('replyImageRemoveConfirm')}
          </Button>
        </>
      }
    >
      <p className={styles.ask}>{t('replyImageRemoveDescription')}</p>
      <p className={styles.note}>{t('replyImageRemoveNote')}</p>
    </Modal>
  )
}

/** 修复不了（本地原件缺失或系统解不了）时，问用户是否移除坏图后继续 */
export const askRemoveUnsupportedImage = (): Promise<boolean> =>
  new Promise((resolve) => {
    // 上一次还开着就直接按取消处理，避免两个 Promise 抢同一个根
    if (settle) {
      const previous = settle
      settle = null
      previous(false)
    }
    settle = resolve
    if (!root) {
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
    }
    root.render(<UnsupportedImageDialog />)
  })
