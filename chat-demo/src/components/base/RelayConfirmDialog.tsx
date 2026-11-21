import { createRoot, type Root } from 'react-dom/client'
import { useTranslate } from '../../i18n/index.js'
import { Button } from './Button.js'
import { Modal } from './Modal.js'
import styles from './ContextCompressDialog.module.css'

/** 与上下文压缩提示共用宿主：按需挂到 body，用 Promise 把选择交回调用方 */
let host: HTMLElement | null = null
let root: Root | null = null
let settle: ((value: boolean) => void) | null = null

const finish = (value: boolean) => {
  const resolve = settle
  settle = null
  root?.render(null)
  resolve?.(value)
}

const RelayDialog = () => {
  const t = useTranslate()
  return (
    <Modal
      title={t('relayConfirmTitle')}
      onClose={() => finish(false)}
      footer={
        <>
          <Button variant="outlined" onClick={() => finish(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={() => finish(true)}>{t('relayConfirmOk')}</Button>
        </>
      }
    >
      <p className={styles.ask}>{t('relayConfirmDescription')}</p>
      <p className={styles.note}>{t('relayConfirmNote')}</p>
    </Modal>
  )
}

/** 二次确认：启用自定义模型前的说明 */
export const askRelayEnable = (): Promise<boolean> =>
  new Promise((resolve) => {
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
    root.render(<RelayDialog />)
  })
