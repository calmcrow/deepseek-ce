import { create } from 'zustand'

/**
 * 会话整理模式（实验）：只是给会话分类，不改变任何对话行为。
 * 折叠分组单独存 localStorage，不写进会话本身，避免影响导出格式。
 */
export type SessionFolder = { id: string; name: string }

const FOLDERS_KEY = 'chat-demo:session-folders'
const MAP_KEY = 'chat-demo:session-folder-map'

const read = (key: string): string | null => {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}

const write = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 无痕模式等写入失败时忽略 */
  }
}

const initialFolders = (): SessionFolder[] => {
  const raw = read(FOLDERS_KEY)
  if (!raw) {
    return []
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!Array.isArray(parsed)) {
      return []
    }
    return parsed.filter(
      (item): item is SessionFolder =>
        typeof item === 'object' &&
        item !== null &&
        typeof (item as SessionFolder).id === 'string' &&
        typeof (item as SessionFolder).name === 'string'
    )
  } catch {
    return []
  }
}

const initialMap = (): Record<string, string> => {
  const raw = read(MAP_KEY)
  if (!raw) {
    return {}
  }
  try {
    const parsed = JSON.parse(raw) as unknown
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, string>) : {}
  } catch {
    return {}
  }
}

const persist = (folders: SessionFolder[], map: Record<string, string>) => {
  write(FOLDERS_KEY, JSON.stringify(folders))
  write(MAP_KEY, JSON.stringify(map))
}

const newId = () => `folder-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export const useSessionFolders = create<{
  folders: SessionFolder[]
  map: Record<string, string>
}>(() => ({
  folders: initialFolders(),
  map: initialMap(),
}))

export const addSessionFolder = (name: string): string | null => {
  const trimmed = name.trim()
  if (!trimmed) {
    return null
  }
  const id = newId()
  const { folders, map } = useSessionFolders.getState()
  const next = [...folders, { id, name: trimmed }]
  useSessionFolders.setState({ folders: next })
  persist(next, map)
  return id
}

export const renameSessionFolder = (id: string, name: string) => {
  const trimmed = name.trim()
  if (!trimmed) {
    return
  }
  const { folders, map } = useSessionFolders.getState()
  const next = folders.map((folder) => (folder.id === id ? { ...folder, name: trimmed } : folder))
  useSessionFolders.setState({ folders: next })
  persist(next, map)
}

export const removeSessionFolder = (id: string) => {
  const { folders, map } = useSessionFolders.getState()
  const nextFolders = folders.filter((folder) => folder.id !== id)
  const nextMap = Object.fromEntries(
    Object.entries(map).filter(([, folderId]) => folderId !== id)
  ) as Record<string, string>
  useSessionFolders.setState({ folders: nextFolders, map: nextMap })
  persist(nextFolders, nextMap)
}

/** 把会话放进某个分组；folderId 传 null 表示移出分组 */
export const assignSessionFolder = (sessionId: string, folderId: string | null) => {
  const { folders, map } = useSessionFolders.getState()
  const nextMap = Object.fromEntries(
    Object.entries(map).filter(([id]) => (folderId ? id !== sessionId : id !== sessionId))
  ) as Record<string, string>
  if (folderId) {
    nextMap[sessionId] = folderId
  }
  useSessionFolders.setState({ map: nextMap })
  persist(folders, nextMap)
}

/** 会话被删除时顺手清掉归属，避免留下孤儿记录 */
export const forgetSessions = (sessionIds: string[]) => {
  const { folders, map } = useSessionFolders.getState()
  const drop = new Set(sessionIds)
  const nextMap = Object.fromEntries(
    Object.entries(map).filter(([id]) => !drop.has(id))
  ) as Record<string, string>
  useSessionFolders.setState({ map: nextMap })
  persist(folders, nextMap)
}
