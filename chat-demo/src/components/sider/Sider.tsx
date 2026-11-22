import clsx from 'clsx'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useTranslate } from '../../i18n/index.js'
import {
  IconCheckedOutline14,
  IconChevronDownOutline14,
  IconCloseFill14,
  IconPanelLeftOutline16,
  IconEllipsisOutline16,
  IconEditOutline16,
  IconTrashOutline16,
  IconSearchOutline16,
  IconSettingsOutline16,
  NewChatIcon,
} from '../base/icons.js'
import { Menu } from '../base/Menu.js'
import { setSiderCollapsed } from '../../services/settings.js'
import { useSettings } from '../../services/settings.js'
import {
  assignSessionFolder,
  removeSessionFolder,
  renameSessionFolder,
  useSessionFolders,
} from '../../services/chat/sessionFolders.js'
import { groupSessions } from '../../services/chat/sessionGroups.js'
import { searchSessions, type SessionSearchHit } from '../../services/chat/search.js'
import {
  newChat,
  pinSession,
  removeSession,
  removeSessions,
  useChatStore,
} from '../../services/chat/store.js'
import type { SessionSummary } from '../../services/chat/types.js'
import { Button } from '../base/Button.js'
import { IconButton } from '../base/IconButton.js'
import { Modal } from '../base/Modal.js'
import { showToast } from '../base/toastState.js'
import { openSettings } from '../settings/settingsDialogState.js'
import { closeMobileSider, useMobileSider } from './mobileSiderState.js'
import { SessionItem } from './SessionItem.js'
import styles from './Sider.module.css'

/** 搜索输入到发起查询之间的等待时间 */
const SEARCH_DEBOUNCE = 250

/**
 * 展开的侧边栏：名称与收起按钮、搜索框、开启新对话、
 * 置顶分组 + 按时间分组的会话列表、底部设置；多选模式下底部换成批量操作栏。
 */
export const Sider = ({ mobile = false }: { mobile?: boolean }) => {
  const t = useTranslate()
  const sessions = useChatStore((state) => state.sessions)
  const activeId = useChatStore((state) => state.activeId)
  const [now, setNow] = useState(Date.now)
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<SessionSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [pinnedOpen, setPinnedOpen] = useState(true)
  const [selectMode, setSelectMode] = useState(false)
  const [selected, setSelected] = useState<ReadonlySet<string>>(() => new Set())
  const [deleting, setDeleting] = useState<SessionSummary | null>(null)
  const [batchDeleting, setBatchDeleting] = useState(false)
  const [deletePending, setDeletePending] = useState(false)
  const searchToken = useRef(0)

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>
    const refresh = () => {
      clearTimeout(timer)
      const time = Date.now()
      setNow(time)
      const midnight = new Date(time).setHours(24, 0, 0, 0)
      timer = setTimeout(refresh, midnight - time)
    }
    const onVisibilityChange = () => {
      if (document.visibilityState === 'visible') {
        refresh()
      }
    }
    refresh()
    document.addEventListener('visibilitychange', onVisibilityChange)
    window.addEventListener('focus', refresh)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('visibilitychange', onVisibilityChange)
      window.removeEventListener('focus', refresh)
    }
  }, [])

  // 搜索：输入停下 250ms 后查一次标题与正文，输入变化时丢弃过期结果
  useEffect(() => {
    const keyword = query.trim()
    if (!keyword) {
      searchToken.current += 1
      setHits(null)
      setSearching(false)
      return
    }
    setSearching(true)
    const token = (searchToken.current += 1)
    const timer = setTimeout(() => {
      void searchSessions(keyword)
        .then((result) => {
          if (token === searchToken.current) {
            setHits(result)
          }
        })
        .catch(() => {
          if (token === searchToken.current) {
            setHits([])
          }
        })
        .finally(() => {
          if (token === searchToken.current) {
            setSearching(false)
          }
        })
    }, SEARCH_DEBOUNCE)
    return () => clearTimeout(timer)
  }, [query])

  const pinned = useMemo(
    () =>
      sessions
        .filter((session) => session.pinnedAt)
        .sort((a, b) => (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0)),
    [sessions]
  )
  const unpinned = useMemo(() => sessions.filter((session) => !session.pinnedAt), [sessions])
  // 会话整理模式：分到自定义分组的会话单独成节，剩下的仍按时间分组
  const organizer = useSettings((state) => state.sessionOrganizer)
  /** 拖动会话时高亮的分组标题 */
  const [dropFolderId, setDropFolderId] = useState<string | null>(null)
  /** 正在重命名的分组 */
  const [editingFolder, setEditingFolder] = useState<{ id: string; name: string } | null>(null)
  const folderList = useSessionFolders((state) => state.folders)
  const folderMap = useSessionFolders((state) => state.map)
  const folderIds = useMemo(() => new Set(folderList.map((folder) => folder.id)), [folderList])
  const inFolder = useCallback(
    (session: SessionSummary) => {
      const folderId = folderMap[session.id]
      return Boolean(folderId && folderIds.has(folderId))
    },
    [folderMap, folderIds]
  )
  const folderSections = useMemo(() => {
    if (!organizer) {
      return []
    }
    // 空分组也要渲染：否则新建的分组没有落点，会话拖不进去
    return folderList.map((folder) => ({
      folder,
      sessions: unpinned.filter((session) => folderMap[session.id] === folder.id),
    }))
  }, [organizer, folderList, folderMap, unpinned])
  const restUnpinned = useMemo(
    () => (organizer ? unpinned.filter((session) => !inFolder(session)) : unpinned),
    [organizer, unpinned, inFolder]
  )
  const groups = useMemo(() => groupSessions(restUnpinned, now, t), [restUnpinned, now, t])

  const searchingActive = query.trim().length > 0
  const visibleIds = useMemo(
    () =>
      searchingActive
        ? (hits ?? []).map((hit) => hit.id)
        : [...pinned, ...groups.flatMap((group) => group.sessions)].map((session) => session.id),
    [searchingActive, hits, pinned, groups]
  )
  const allSelected =
    visibleIds.length > 0 && visibleIds.every((id) => selected.has(id))

  const toggleSelectMode = () => {
    setSelectMode((on) => {
      if (on) {
        setSelected(new Set())
      }
      return !on
    })
  }

  const toggleSelected = (id: string) => {
    setSelected((current) => {
      const next = new Set(current)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const confirmBatchDelete = async () => {
    setDeletePending(true)
    try {
      const removed = await removeSessions([...selected])
      if (removed === 0) {
        showToast({ key: 'sessionDeleteFailed', type: 'error' })
      }
      setBatchDeleting(false)
      setSelectMode(false)
      setSelected(new Set())
    } finally {
      setDeletePending(false)
    }
  }

  const renderItem = (session: SessionSummary | SessionSearchHit) => (
    <SessionItem
      key={session.id}
      session={session}
      active={session.id === activeId}
      snippet={'snippet' in session ? session.snippet : undefined}
      selectable={selectMode}
      selected={selected.has(session.id)}
      onToggleSelect={() => toggleSelected(session.id)}
      onPin={() => pinSession(session.id, !session.pinnedAt)}
      onDelete={() => setDeleting(session)}
    />
  )

  return (
    <div className={clsx(styles.sider, mobile && styles.mobile)}>
      <div className={styles.top}>
        <div className={styles.appName}>{t('appName')}</div>
        <IconButton
          size="m"
          icon={<IconCheckedOutline14 />}
          tooltip={selectMode ? t('siderSelectDone') : t('siderSelectMode')}
          tooltipPlacement="bottom"
          onClick={toggleSelectMode}
        />
        <IconButton
          size="m"
          icon={<IconPanelLeftOutline16 />}
          tooltip={t('collapseSiderbarButton')}
          tooltipPlacement="bottom"
          onClick={() => (mobile ? closeMobileSider() : setSiderCollapsed(true))}
        />
      </div>
      <div className={styles.search}>
        <span className={styles.searchIcon}>
          <IconSearchOutline16 />
        </span>
        <input
          className={styles.searchInput}
          value={query}
          placeholder={t('siderSearchPlaceholder')}
          spellCheck={false}
          onChange={(event) => setQuery(event.target.value)}
        />
        {query ? (
          <button
            type="button"
            className={styles.searchClear}
            aria-label={t('cancel')}
            onClick={() => setQuery('')}
          >
            <IconCloseFill14 />
          </button>
        ) : null}
      </div>
      <button
        type="button"
        className={styles.newChat}
        onClick={() => {
          newChat()
          closeMobileSider()
        }}
      >
        <span className={styles.newChatIcon}>
          <NewChatIcon />
        </span>
        {t('newChat')}
      </button>
      <div className={styles.listWrap}>
        <div className={styles.list}>
          {searchingActive ? (
            <div className={styles.section}>
              <div className={styles.sectionHeader}>
                {searching
                  ? t('siderSearching')
                  : t('siderSearchCount', { count: hits?.length ?? 0 })}
              </div>
              {(hits ?? []).map(renderItem)}
              {!searching && hits && hits.length === 0 ? (
                <div className={styles.empty}>{t('siderSearchNoResult')}</div>
              ) : null}
            </div>
          ) : (
            <>
              {pinned.length > 0 ? (
                <div className={styles.section}>
                  <button
                    type="button"
                    className={clsx(styles.sectionHeader, styles.sectionToggle)}
                    onClick={() => setPinnedOpen((open) => !open)}
                  >
                    {t('siderPinnedSection', { count: pinned.length })}
                    <span className={clsx(styles.chevron, !pinnedOpen && styles.chevronClosed)}>
                      <IconChevronDownOutline14 />
                    </span>
                  </button>
                  {pinnedOpen ? pinned.map(renderItem) : null}
                </div>
              ) : null}
              {folderSections.map((section) => (
                <div key={section.folder.id} className={styles.section}>
                  <div
                    className={clsx(
                      styles.sectionHeader,
                      styles.folderHeader,
                      dropFolderId === section.folder.id && styles.folderDropTarget
                    )}
                    onDragOver={(event) => {
                      event.preventDefault()
                      setDropFolderId(section.folder.id)
                    }}
                    onDragLeave={() => setDropFolderId(null)}
                    onDrop={(event) => {
                      event.preventDefault()
                      const dragged = event.dataTransfer.getData('text/session-id')
                      if (dragged) {
                        assignSessionFolder(dragged, section.folder.id)
                      }
                      setDropFolderId(null)
                    }}
                  >
                    {editingFolder?.id === section.folder.id ? (
                      <input
                        className={styles.folderRenameInput}
                        autoFocus
                        defaultValue={editingFolder.name}
                        onBlur={(event) => {
                          renameSessionFolder(section.folder.id, event.target.value)
                          setEditingFolder(null)
                        }}
                        onKeyDown={(event) => {
                          if (event.key === 'Enter' && !event.nativeEvent.isComposing) {
                            renameSessionFolder(section.folder.id, event.currentTarget.value)
                            setEditingFolder(null)
                          } else if (event.key === 'Escape') {
                            setEditingFolder(null)
                          }
                        }}
                      />
                    ) : (
                      <>
                        <span className={styles.folderName}>{section.folder.name}</span>
                        <Menu
                          options={[
                            {
                              key: 'rename',
                              label: t('folderRename'),
                              icon: <IconEditOutline16 />,
                              onSelect: () =>
                                setEditingFolder({
                                  id: section.folder.id,
                                  name: section.folder.name,
                                }),
                            },
                            {
                              key: 'delete',
                              label: t('folderDelete'),
                              icon: <IconTrashOutline16 />,
                              danger: true,
                              onSelect: () => {
                                removeSessionFolder(section.folder.id)
                                showToast({ key: 'folderDeleted' })
                              },
                            },
                          ]}
                        >
                          {({ toggle }) => (
                            <IconButton
                              size="xs"
                              icon={<IconEllipsisOutline16 />}
                              aria-label={t('folderActions')}
                              onClick={toggle}
                            />
                          )}
                        </Menu>
                      </>
                    )}
                  </div>
                  {section.sessions.length > 0 ? (
                    section.sessions.map(renderItem)
                  ) : (
                    <div className={styles.folderEmpty}>{t('folderEmptyHint')}</div>
                  )}
                </div>
              ))}
              {groups.map((group) => (
                <div key={group.key} className={styles.section}>
                  <div className={styles.sectionHeader}>{group.label}</div>
                  {group.sessions.map(renderItem)}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      {selectMode ? (
        <div className={styles.selectBar}>
          <button
            type="button"
            className={styles.selectAll}
            onClick={() => setSelected(allSelected ? new Set() : new Set(visibleIds))}
          >
            {t(allSelected ? 'siderSelectNone' : 'siderSelectAll')}
          </button>
          <span className={styles.selectCount}>
            {t('siderSelectedCount', { count: selected.size })}
          </span>
          <Button
            variant="danger"
            size="m"
            disabled={selected.size === 0 || deletePending}
            onClick={() => setBatchDeleting(true)}
          >
            {t('delete')}
          </Button>
        </div>
      ) : (
        <div className={styles.bottom}>
          <button type="button" className={styles.settings} onClick={() => openSettings('general')}>
            <span className={styles.settingsIcon}>
              <IconSettingsOutline16 />
            </span>
            <span className={styles.settingsLabel}>{t('settings')}</span>
          </button>
        </div>
      )}
      {deleting ? (
        <Modal
          title={t('deleteSessionModalContentTitle')}
          onClose={() => {
            if (!deletePending) {
              setDeleting(null)
            }
          }}
          footer={
            <>
              <Button variant="outlined" disabled={deletePending} onClick={() => setDeleting(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                disabled={deletePending}
                onClick={async () => {
                  setDeletePending(true)
                  try {
                    if (await removeSession(deleting.id)) {
                      setDeleting(null)
                    } else {
                      showToast({ key: 'sessionDeleteFailed', type: 'error' })
                    }
                  } finally {
                    setDeletePending(false)
                  }
                }}
              >
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
      {batchDeleting ? (
        <Modal
          title={t('siderBatchDeleteTitle', { count: selected.size })}
          onClose={() => {
            if (!deletePending) {
              setBatchDeleting(false)
            }
          }}
          footer={
            <>
              <Button
                variant="outlined"
                disabled={deletePending}
                onClick={() => setBatchDeleting(false)}
              >
                {t('cancel')}
              </Button>
              <Button variant="danger" disabled={deletePending} onClick={() => void confirmBatchDelete()}>
                {t('delete')}
              </Button>
            </>
          }
        >
          {t('deleteSessionWithFilesDescription')}
        </Modal>
      ) : null}
    </div>
  )
}

/** 移动端抽屉：浮在页面上方，点空白区域关闭。 */
export const MobileSider = () => {
  const open = useMobileSider((state) => state.open)
  const drag = useMobileSider((state) => state.drag)
  // 拖拽过程中（drag 有值）也要渲染，否则抽屉跟不上手指
  if (!open && drag === null) {
    return null
  }
  const width = Math.min(300, window.innerWidth - 48)
  const revealed = drag ?? width
  const progress = Math.max(0, Math.min(1, revealed / width))
  const dragging = drag !== null
  return (
    <>
      <div
        className={clsx(styles.drawerMask, !dragging && styles.maskSettled)}
        style={{ opacity: progress }}
        onClick={closeMobileSider}
      />
      <div
        className={clsx(styles.drawer, !dragging && styles.drawerSettled)}
        style={
          open && !dragging
            ? undefined
            : { transform: `translateX(${Math.min(0, revealed - width)}px)` }
        }
      >
        <Sider mobile />
      </div>
    </>
  )
}
