import { createRoot, type Root } from 'react-dom/client'
import { useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import { Button } from './Button.js'
import { Modal } from './Modal.js'
import { addSessionFolder, useSessionFolders } from '../../services/chat/sessionFolders.js'
import styles from './FolderDialog.module.css'

/**
 * 选择会话归属的分组。整理模式专属；只做归类，不影响对话。
 * 返回值：分组 id、null 表示移出分组、undefined 表示取消。
 */
let host: HTMLElement | null = null
let root: Root | null = null
let settle: ((value: string | null | undefined) => void) | null = null

const finish = (value: string | null | undefined) => {
  const resolve = settle
  settle = null
  root?.render(null)
  resolve?.(value)
}

const FolderPicker = ({ current }: { current: string | null }) => {
  const t = useTranslate()
  const folders = useSessionFolders((state) => state.folders)
  const [selected, setSelected] = useState<string | null>(current)
  const [creating, setCreating] = useState(false)
  const [draftName, setDraftName] = useState('')
  return (
    <Modal
      title={t('folderPickerTitle')}
      onClose={() => finish(undefined)}
      footer={
        <>
          <Button variant="outlined" onClick={() => finish(undefined)}>
            {t('cancel')}
          </Button>
          <Button onClick={() => finish(selected)}>{t('folderPickerConfirm')}</Button>
        </>
      }
    >
      <p className={styles.note}>{t('folderPickerNote')}</p>
      <div className={styles.list}>
        <button
          type="button"
          className={selected === null ? styles.itemActive : styles.item}
          onClick={() => setSelected(null)}
        >
          {t('folderPickerNone')}
        </button>
        {folders.map((folder) => (
          <button
            key={folder.id}
            type="button"
            className={selected === folder.id ? styles.itemActive : styles.item}
            onClick={() => setSelected(folder.id)}
          >
            {folder.name}
          </button>
        ))}
      </div>
      {creating ? (
        <div className={styles.createRow}>
          <input
            className={styles.input}
            autoFocus
            value={draftName}
            placeholder={t('folderNewPlaceholder')}
            onChange={(event) => setDraftName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                const id = addSessionFolder(draftName)
                if (id) {
                  setSelected(id)
                  setDraftName('')
                  setCreating(false)
                }
              }
            }}
          />
          <Button
            size="s"
            onClick={() => {
              const id = addSessionFolder(draftName)
              if (id) {
                setSelected(id)
                setDraftName('')
                setCreating(false)
              }
            }}
          >
            {t('folderNewConfirm')}
          </Button>
        </div>
      ) : (
        <button type="button" className={styles.newButton} onClick={() => setCreating(true)}>
          {t('folderNew')}
        </button>
      )}
    </Modal>
  )
}

export const askSessionFolder = (current: string | null): Promise<string | null | undefined> =>
  new Promise((resolve) => {
    if (settle) {
      const previous = settle
      settle = null
      previous(undefined)
    }
    settle = resolve
    if (!root) {
      host = document.createElement('div')
      document.body.append(host)
      root = createRoot(host)
    }
    root.render(<FolderPicker current={current} />)
  })
