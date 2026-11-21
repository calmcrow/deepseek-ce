import { create } from 'zustand'
import type { LinkedMessage, TranslationMessage } from '../i18n/index.js'
import { ApiError, uploadFile } from './api/client.js'
import { classifyApiError, getUploadErrorInfo, isRetryableApiError } from './api/errors.js'
import type { FilePurpose } from './api/types.js'
import { ACCEPT_FILE_EXTS } from './uploadExts.js'

/** 允许上传的扩展名，按扩展名白名单过滤，清单见 uploadExts.ts */
export const ACCEPTED_EXTS = ACCEPT_FILE_EXTS
/** 选择文件对话框的过滤条件 */
export const ACCEPT = ACCEPTED_EXTS.map((ext) => `.${ext}`).join(',')
/** 单文件大小上限与 Files API 一致 */
export const MAX_SIZE_MB = 64
/** 按 user_data 上传的文件（纯文本、代码、表格、电子书）原文件上限更小 */
export const MAX_USER_DATA_SIZE_MB = 32
export const MAX_COUNT = 50
/** 同时上传的文件数 */
const MAX_CONCURRENT = 3

/** 文件扩展名（小写，不含点）；没有扩展名时为空 */
export const getFileExt = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : ''
}

export const isAcceptedExt = (name: string) => ACCEPTED_EXTS.includes(getFileExt(name))

/** 需要服务端做版面解析的文档；其余非图片文件（纯文本、代码、表格、电子书）无需解析 */
const LAYOUT_RECOGNITION_EXTS = new Set(['pdf', 'doc', 'docx', 'ppt', 'pptx'])

/** 上传时的 purpose：图片不传，PDF 与 Word、PPT 做版面解析，其余按 user_data 上传 */
export const getUploadPurpose = (name: string, isImage: boolean): FilePurpose | null => {
  if (isImage) {
    return null
  }
  return LAYOUT_RECOGNITION_EXTS.has(getFileExt(name)) ? 'rich_layout_recognition' : 'user_data'
}

/** 文件允许的最大体积（MB），按上传时的 purpose 区分 */
const getMaxSizeMB = (file: File) =>
  getUploadPurpose(file.name, isImage(resolveMimeType(file))) === 'user_data'
    ? MAX_USER_DATA_SIZE_MB
    : MAX_SIZE_MB

/** 添加前校验：格式 → 大小 → 数量，任一不满足即整批不添加 */
export const validateFiles = (files: File[], currentCount: number): TranslationMessage | null => {
  // 安卓相册选择器给回来的名字经常没有扩展名，这时只能看 MIME；
  // 图片一律放行，否则整批会被误判成「不支持的格式」而什么都不显示
  if (files.some((file) => !isAcceptedExt(file.name) && !isImage(resolveMimeType(file)))) {
    return { key: 'uploadUnsupportedFormat' }
  }
  const oversized = files.find((file) => file.size > getMaxSizeMB(file) * 1024 * 1024)
  if (oversized) {
    return { key: 'uploadMaxMBSize', params: { size: getMaxSizeMB(oversized) } }
  }
  if (currentCount + files.length > MAX_COUNT) {
    return { key: 'uploadMaxFiles', params: { count: MAX_COUNT } }
  }
  return null
}

/**
 * 上传失败在附件上显示的文案：与设计稿状态对应的用具体原因，其余统一「上传失败」。
 * 服务端原文多为英文且较长，不直接展示。
 */
/** 把失败原因压成一行人话：状态码 + 服务端原话（截断），用于兜底文案 */
const describeUploadReason = (error: unknown): string => {
  if (error instanceof ApiError) {
    const text = error.message.trim().replace(/\s+/g, ' ')
    const short = text.length > 90 ? `${text.slice(0, 90)}…` : text
    return error.status ? `${error.status} · ${short}` : short
  }
  if (error instanceof Error) {
    return error.message.trim().replace(/\s+/g, ' ').slice(0, 90)
  }
  return String(error).slice(0, 90)
}

export const describeUploadError = (error: unknown): TranslationMessage => {
  const condition = classifyApiError(error)
  if (condition === 'serverBusy') {
    return { key: 'uploadServerBusy' }
  }
  if (condition === 'insufficientBalance') {
    return { key: 'insufficientBalance' }
  }
  if (condition === 'unauthorized') {
    return { key: 'apiKeyInvalid' }
  }
  if (condition === 'tooLarge') {
    return { key: 'uploadTooLarge' }
  }
  const info = getUploadErrorInfo(error)
  if (info?.code === 'parseFailed') {
    return { key: 'uploadParseFailed' }
  }
  if (info?.code === 'fileCountLimit') {
    return { key: 'uploadFileCountLimit', params: { limit: info.limit ?? '' } }
  }
  if (info?.code === 'storageLimit') {
    return { key: 'uploadStorageLimit', params: { limit: info.limit ?? '' } }
  }
  // 兜底也要带原因：只显示「上传失败」的话，用户和作者都没法判断问题出在哪
  return { key: 'uploadFailedWithReason', params: { reason: describeUploadReason(error) } }
}

type NoticeListener = (notice: LinkedMessage) => void
const noticeListeners = new Set<NoticeListener>()

/** 订阅需要额外提示的上传失败（配额达到上限），由界面层转成 toast */
export const onUploadNotice = (listener: NoticeListener) => {
  noticeListeners.add(listener)
  return () => {
    noticeListeners.delete(listener)
  }
}

/** 删除已上传文件的接口文档 */
const DELETE_FILE_DOCS_URL = 'https://api-docs.deepseek.com/api/delete-file'

/** 文件数或存储空间达到上限：附件上只放得下「上传失败」，原因另用 toast 说明并引导删除旧文件 */
export const describeUploadQuota = (error: unknown): LinkedMessage | undefined => {
  const info = getUploadErrorInfo(error)
  const link = { key: 'uploadDeleteFiles', href: DELETE_FILE_DOCS_URL } as const
  if (info?.code === 'fileCountLimit') {
    return { type: 'error', key: 'uploadFileCountLimit', params: { limit: info.limit ?? '' }, link }
  }
  if (info?.code === 'storageLimit') {
    return { type: 'error', key: 'uploadStorageLimit', params: { limit: info.limit ?? '' }, link }
  }
  return undefined
}

type Job = () => Promise<void>
const queue: Job[] = []
let running = 0

const next = () => {
  while (running < MAX_CONCURRENT) {
    const job = queue.shift()
    if (!job) {
      return
    }
    running++
    void job().finally(() => {
      running--
      next()
    })
  }
}

/** 排队上传，最多同时上传 MAX_CONCURRENT 个；排队期间中止的任务不会发出请求 */
const enqueueUpload = (
  apiKey: string,
  file: Blob,
  name: string,
  isImage: boolean,
  signal: AbortSignal
) =>
  new Promise<string>((resolve, reject) => {
    queue.push(async () => {
      if (signal.aborted) {
        reject(signal.reason)
        return
      }
      try {
        const body = file instanceof File ? file : new File([file], name, { type: file.type })
        resolve((await uploadFile(apiKey, body, getUploadPurpose(name, isImage), signal)).id)
      } catch (error) {
        reject(error)
      }
    })
    next()
  })

/**
 * 上传任务按附件的本地 id 登记：输入框选中即开始上传，全部成功后携带 serverId 发送，
 * 不会重复上传；导入的历史附件没有任务，发送前按本地原件补传。
 * 任务只在内存里，历史附件补传未完成时，刷新后会在下次请求前重新上传。
 */
export type UploadTask =
  | { status: 'uploading' }
  | { status: 'done'; serverId: string }
  | { status: 'error'; error: TranslationMessage; retryable: boolean }

type UploadState = { tasks: Record<string, UploadTask> }

export const useUploads = create<UploadState>(() => ({ tasks: {} }))

const setTask = (id: string, task: UploadTask | null) =>
  useUploads.setState((state) => ({
    tasks: task
      ? { ...state.tasks, [id]: task }
      : Object.fromEntries(Object.entries(state.tasks).filter(([key]) => key !== id)),
  }))

const pending = new Map<string, { promise: Promise<string>; controller: AbortController }>()

/** 开始（或复用进行中的）上传，返回服务端 file_id；失败时任务记为 error 并抛出原错误 */
export const uploadAttachment = (
  apiKey: string,
  id: string,
  blob: Blob,
  name: string,
  isImage: boolean
): Promise<string> => {
  const current = pending.get(id)
  if (current) {
    return current.promise
  }
  const controller = new AbortController()
  setTask(id, { status: 'uploading' })
  const promise = enqueueUpload(apiKey, blob, name, isImage, controller.signal)
    .then((serverId) => {
      setTask(id, { status: 'done', serverId })
      return serverId
    })
    .catch((error: unknown) => {
      if (controller.signal.aborted) {
        setTask(id, null)
      } else {
        setTask(id, {
          status: 'error',
          error: describeUploadError(error),
          retryable: isRetryableApiError(error),
        })
        const notice = describeUploadQuota(error)
        if (notice) {
          for (const listener of noticeListeners) {
            listener(notice)
          }
        }
      }
      throw error
    })
    .finally(() => pending.delete(id))
  pending.set(id, { promise, controller })
  return promise
}

export const cancelUpload = (id: string) => {
  pending.get(id)?.controller.abort()
  setTask(id, null)
}

/** 各扩展名对应的 MIME：部分系统（如 Windows）给不出 file.type，按扩展名补齐 */
const MIME_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
}

/** 取文件的 MIME：优先用浏览器给出的类型，缺失时按扩展名推断 */
export const resolveMimeType = (file: File) => file.type || MIME_BY_EXT[getFileExt(file.name)] || ''

/** 图片 MIME → 扩展名；用来给没有扩展名的文件补一个，否则上传与用途判断都会失效 */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/bmp': 'bmp',
  'image/heic': 'heic',
  'image/heif': 'heic',
}

/**
 * 没有扩展名的文件补一个（安卓相册/文件选择器常给不带扩展名的名字）。
 * 补不了就原样返回，交给上层校验。
 */
export const normalizeFileName = (file: File): File => {
  if (getFileExt(file.name)) {
    return file
  }
  const mime = resolveMimeType(file)
  const ext = EXT_BY_MIME[mime]
  if (!ext) {
    return file
  }
  const base = file.name.trim() || `image-${Date.now()}`
  return new File([file], `${base}.${ext}`, { type: mime, lastModified: file.lastModified })
}

export const isImage = (mimeType: string) => mimeType.startsWith('image/')

/**
 * 服务端真正接受的图片格式：JPEG / PNG / GIF / WebP，而且按**真实字节**判定。
 * 只判 image/ 前缀会把 HEIC、BMP、TIFF、SVG、AVIF 全放过去，换来一个 400，
 * 而坏图会随每一轮请求重发，整条会话都会被毒死。
 */
const SUPPORTED_IMAGE_MIME = /^image\/(png|jpeg|gif|webp)$/

export const isSupportedImage = (mimeType: string) => SUPPORTED_IMAGE_MIME.test(mimeType)

/** 可能出现在相册里的「图片但服务端不认」的扩展名，命中就走转码 */
export const CONVERT_IMAGE_EXTS = new Set(['heic', 'heif', 'bmp', 'tif', 'tiff', 'avif', 'svg', 'ico'])

/** 服务端认的图片扩展名：嗅探失败（老内核/MIME 缺失）时按它兜底，别把图片当文档 */
export const SUPPORTED_IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp'])

/** 读前 16 字节按文件头认格式；认不出来返回空串 */
export const sniffImageMime = async (file: Blob): Promise<string> => {
  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
    const text = (from: number, to: number) =>
      String.fromCharCode(...head.subarray(from, to))
    if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) {
      return 'image/jpeg'
    }
    if (head[0] === 0x89 && text(1, 4) === 'PNG') {
      return 'image/png'
    }
    if (text(0, 4) === 'GIF8') {
      return 'image/gif'
    }
    if (text(0, 4) === 'RIFF' && text(8, 12) === 'WEBP') {
      return 'image/webp'
    }
    if (text(4, 8) === 'ftyp') {
      const brand = text(8, 12)
      if (brand.startsWith('avif')) {
        return 'image/avif'
      }
      if (/^(heic|heix|heif|mif1|msf1)/.test(brand)) {
        return 'image/heic'
      }
    }
    if (text(0, 2) === 'BM') {
      return 'image/bmp'
    }
    if (
      (head[0] === 0x49 && head[1] === 0x49 && head[2] === 0x2a) ||
      (head[0] === 0x4d && head[1] === 0x4d && head[3] === 0x2a)
    ) {
      return 'image/tiff'
    }
    return ''
  } catch {
    return ''
  }
}

/** 转码后长边上限与质量：顺带把手机原图压小，上传更快 */
const JPEG_MAX_SIDE = 2048
const JPEG_QUALITY = 0.9

/** 服务端硬限制：宽高都不得超过 8192 像素 */
export const MAX_IMAGE_SIDE = 8192
/** 超限时缩到这个尺寸（留足余量，避免边界上又被拒） */
export const DOWNSIZE_SIDE = 4096

/** 读图片真实像素尺寸；解不出来返回 null */
export const probeImageSize = async (
  file: Blob
): Promise<{ width: number; height: number } | null> => {
  try {
    const bitmap = await createImageBitmap(file)
    const size = { width: bitmap.width, height: bitmap.height }
    bitmap.close()
    return size
  } catch {
    return null
  }
}

/** 图片是否超过服务端的边长上限 */
export const isOversizedImage = (size: { width: number; height: number } | null): boolean =>
  size !== null && (size.width > MAX_IMAGE_SIDE || size.height > MAX_IMAGE_SIDE)

/**
 * 把服务端不认的位图（HEIC / BMP / TIFF / AVIF 等）转成 JPEG。
 * 解码交给系统（WebView 通常能解 HEIC）；失败返回 null，由调用方给出明确提示。
 */
export const convertImageToJpeg = async (
  file: File,
  maxSide = JPEG_MAX_SIDE,
  quality = JPEG_QUALITY
): Promise<File | null> => {
  try {
    const bitmap = await createImageBitmap(file)
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height))
    const width = Math.max(1, Math.round(bitmap.width * scale))
    const height = Math.max(1, Math.round(bitmap.height * scale))
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d')
    if (!context) {
      return null
    }
    context.drawImage(bitmap, 0, 0, width, height)
    bitmap.close()
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', quality)
    })
    if (!blob) {
      return null
    }
    // 文件名必须换成 .jpg，否则按扩展名推断出的 MIME 还是旧的
    const base = file.name.replace(/\.[^.\\/]+$/, '').trim() || `image-${Date.now()}`
    return new File([blob], `${base}.jpg`, {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    })
  } catch {
    return null
  }
}

/** 文件扩展名（大写），用于卡片元信息 */
export const getExtension = (name: string) => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot + 1).toUpperCase() : ''
}

export const formatSize = (bytes: number) => {
  if (bytes < 1024) {
    return `${bytes} B`
  }
  const units = ['KB', 'MB', 'GB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit++
  }
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}
