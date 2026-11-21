/**
 * 从链接导入归档：下载这一半交给原生（WebView 里 JS fetch 会被 CORS 拦），
 * 下完的文件由原生登记成 pending，网页在真实点击里打开「导入文件」选择器就能拿到它。
 *
 * 之所以还要用户点一次：Chromium 要求文件选择器必须由用户手势触发，
 * 下载是异步的，回来时手势早就失效了。
 */

type AndroidBridge = {
  downloadArchive?: (url: string) => boolean
  hasPendingArchive?: () => boolean
}

const bridge = () =>
  (window as unknown as { AndroidBridge?: AndroidBridge }).AndroidBridge

/** 只有带原生下载通道的环境（APK）才能用 */
export const canImportFromUrl = () => typeof bridge()?.downloadArchive === 'function'

export type DownloadHandlers = {
  onProgress: (downloaded: number, total: number) => void
}

const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000

/**
 * 让原生开始下载。返回下载到的字节数。
 * 失败（网络错误、非 2xx、链接不是直链）以 Error 抛出，message 里带原因。
 */
export const downloadArchive = (
  url: string,
  { onProgress }: DownloadHandlers
): Promise<number> =>
  new Promise((resolve, reject) => {
    const api = bridge()
    if (!api?.downloadArchive) {
      reject(new Error('native download unavailable'))
      return
    }
    const target = window as unknown as Record<string, unknown>
    let settled = false
    const cleanup = () => {
      settled = true
      clearTimeout(timer)
      delete target.__dsArchiveProgress
      delete target.__dsArchiveReady
      delete target.__dsArchiveFailed
    }
    const timer = setTimeout(() => {
      if (!settled) {
        cleanup()
        reject(new Error('timeout'))
      }
    }, DOWNLOAD_TIMEOUT_MS)

    target.__dsArchiveProgress = (downloaded: number, total: number) => {
      onProgress(downloaded, total)
    }
    target.__dsArchiveReady = (bytes: number) => {
      if (settled) {
        return
      }
      cleanup()
      resolve(bytes)
    }
    target.__dsArchiveFailed = (message: string) => {
      if (settled) {
        return
      }
      cleanup()
      reject(new Error(message || 'failed'))
    }

    if (!api.downloadArchive(url)) {
      cleanup()
      reject(new Error('busy'))
    }
  })

/** 下载完成后调用：在真实点击里触发导入入口，原生会把文件直接交给选择器 */
export const openPendingArchiveImport = () => {
  const input = document.querySelector<HTMLInputElement>(
    'input[data-role="history-import-input"]'
  )
  input?.click()
}
