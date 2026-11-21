import { createRoot, type Root } from 'react-dom/client'
import { useTranslate } from '../../i18n/index.js'
import { Button } from './Button.js'
import { Modal } from './Modal.js'
import styles from './ContextCompressDialog.module.css'

/** 和上下文压缩提示同一套宿主：按需挂到 body，用 Promise 把选择交回调用方 */
let host: HTMLElement | null = null
let root: Root | null = null
let settle: ((value: boolean) => void) | null = null

const finish = (value: boolean) => {
  const resolve = settle
  settle = null
  root?.render(null)
  resolve?.(value)
}

const SendAsTextDialog = ({ name, tokens }: { name: string; tokens: string }) => {
  const t = useTranslate()
  return (
    <Modal
      title={t('sendAsTextTitle')}
      onClose={() => finish(false)}
      footer={
        <>
          <Button variant="outlined" onClick={() => finish(false)}>
            {t('cancel')}
          </Button>
          <Button onClick={() => finish(true)}>{t('sendAsTextConfirm')}</Button>
        </>
      }
    >
      <p className={styles.ask}>{t('sendAsTextDescription', { name, tokens })}</p>
      <p className={styles.note}>{t('sendAsTextNote')}</p>
    </Modal>
  )
}

/** 询问是否改用「正文直发」：把抽取的正文当文本块一次发出，不拆分 */
export const askSendAsText = (name: string, tokens: string): Promise<boolean> =>
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
    root.render(<SendAsTextDialog name={name} tokens={tokens} />)
  })
