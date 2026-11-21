import clsx from 'clsx'
import { memo, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCheckOutline16,
  IconDownloadOutline16,
  IconEditOutline16,
  IconEllipsisOutline16,
  IconPinOutline16,
  IconPanelLeftOutline16,
  IconRefreshOutline16,
  IconTrashOutline16,
} from '../base/icons.js'
import { exportSession } from '../../services/chat/backup.js'
import { compressContext, renameSession, selectSession } from '../../services/chat/store.js'
import { useSettings } from '../../services/settings.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { saveBlob } from '../../utils/download.js'
import { ContextUsageBar } from '../base/ContextUsageBar.js'
import { IconButton } from '../base/IconButton.js'
import { askManualCompress } from '../base/ManualCompressDialog.js'
import { askSessionFolder } from '../base/FolderDialog.js'
import { assignSessionFolder, useSessionFolders } from '../../services/chat/sessionFolders.js'
import { Menu } from '../base/Menu.js'
import { showToast } from '../base/toastState.js'
import { closeMobileSider } from './mobileSiderState.js'
import styles from './SessionItem.module.css'

export const SessionItem = memo(function SessionItem({
  session,
  active,
  snippet,
  selectable = false,
  selected = false,
  onToggleSelect,
  onPin,
  onDelete,
}: {
  session: SessionSummary
  active: boolean
  /** 搜索命中时给出的一段上下文 */
  snippet?: string
  /** 多选模式下点击整行是勾选，而不是打开会话 */
  selectable?: boolean
  selected?: boolean
  onToggleSelect?: () => void
  onPin?: () => void
  onDelete: () => void
}) {
  const t = useTranslate()
  const [editing, setEditing] = useState(false)
  const displayTitle = session.title || t('untitledChat')
  const pinned = Boolean(session.pinnedAt)
  const manualCompress = useSettings((state) => state.manualCompress)
  const organizer = useSettings((state) => state.sessionOrganizer)

  /** 导出这个对话：和全量导出共用队列，产物能被导入器直接读回；失败只提示，不影响会话本身。 */
  const exportOne = async () => {
    try {
      const { name, blob } = await exportSession(session.id)
      const saved = await saveBlob(blob, name)
      showToast(
        saved === 'failed'
          ? { key: 'sessionExportFailed', type: 'error' }
          : { key: 'sessionExportSaved' }
      )
    } catch {
      showToast({ key: 'sessionExportFailed', type: 'error' })
    }
  }

  if (editing) {
    const finish = (title: string) => {
      setEditing(false)
      if (title.trim() && title.trim() !== displayTitle) {
        renameSession(session.id, title.trim())
      }
    }
    return (
      <input
        className={styles.renameInput}
        defaultValue={displayTitle}
        autoFocus
        onFocus={(event) => event.target.select()}
        onBlur={(event) => finish(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
            finish(event.currentTarget.value)
          } else if (event.key === 'Escape') {
            setEditing(false)
          }
        }}
      />
    )
  }

  return (
    <div
      data-session-id={session.id}
      className={clsx(
        styles.item,
        active && styles.active,
        selected && styles.selected,
        snippet && styles.stacked
      )}
      onClick={() => {
        if (selectable) {
          onToggleSelect?.()
          return
        }
        selectSession(session.id)
        closeMobileSider()
      }}
      // 整理模式下可以把会话直接拖到分组标题上
      draggable={organizer && !selectable}
      onDragStart={
        organizer
          ? (event) => {
              event.dataTransfer.setData('text/session-id', session.id)
              event.dataTransfer.effectAllowed = 'move'
            }
          : undefined
      }
    >
      {selectable ? (
        <span className={clsx(styles.check, selected && styles.checkOn)} aria-hidden>
          {selected ? <IconCheckOutline16 /> : null}
        </span>
      ) : null}
      <div className={styles.body}>
        <div className={styles.title}>{displayTitle}</div>
        {snippet ? <div className={styles.snippet}>{snippet}</div> : null}
      </div>
      {selectable ? null : (
        <div className={styles.action} onClick={(event) => event.stopPropagation()}>
          <Menu
            // 菜单最上面先给一条上下文用量：纯展示，替代不了任何操作
            header={<ContextUsageBar usage={session.contextUsage} />}
            options={[
              {
                key: 'pin',
                label: t(pinned ? 'sessionItemMenuUnpinOption' : 'sessionItemMenuPinOption'),
                icon: <IconPinOutline16 />,
                onSelect: () => onPin?.(),
              },
              {
                key: 'rename',
                label: t('sessionItemMenuRenameOption'),
                icon: <IconEditOutline16 />,
                onSelect: () => setEditing(true),
              },
              {
                key: 'export',
                label: t('sessionItemMenuExportOption'),
                icon: <IconDownloadOutline16 />,
                onSelect: () => void exportOne(),
              },
              // 默认关：只有设置里开了「手动压缩上下文」才出现
              ...(manualCompress
                ? [
                    {
                      key: 'compress',
                      label: t('sessionItemMenuCompressOption'),
                      icon: <IconRefreshOutline16 />,
                      onSelect: () => {
                        void askManualCompress().then((confirmed) => {
                          if (confirmed) {
                            void compressContext(session.id)
                          }
                        })
                      },
                    },
                  ]
                : []),
              // 会话整理模式：把会话归进某个分组（只做归类）
              ...(organizer
                ? [
                    {
                      key: 'folder',
                      label: t('sessionFolderMenuOption'),
                      icon: <IconPanelLeftOutline16 />,
                      onSelect: () => {
                        void askSessionFolder(
                          useSessionFolders.getState().map[session.id] ?? null
                        ).then((folderId) => {
                          if (folderId !== undefined) {
                            assignSessionFolder(session.id, folderId)
                          }
                        })
                      },
                    },
                  ]
                : []),
              {
                key: 'delete',
                label: t('delete'),
                icon: <IconTrashOutline16 />,
                danger: true,
                onSelect: onDelete,
              },
            ]}
          >
            {({ toggle }) => (
              <IconButton icon={<IconEllipsisOutline16 />} aria-label={t('more')} onClick={toggle} />
            )}
          </Menu>
        </div>
      )}
    </div>
  )
})
