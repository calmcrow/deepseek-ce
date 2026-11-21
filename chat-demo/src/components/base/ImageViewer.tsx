import { useEffect, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { useTranslate } from '../../i18n/index.js'
import { IconCloseFill14 } from './icons.js'
import styles from './ImageViewer.module.css'

/**
 * 全屏看图。原版 App 里点消息中的图片能放大查看，网页版原来是把图片做成
 * `<a target="_blank">`，而 WebView 不处理新窗口，点了没有任何反应。
 *
 * 手势：双指缩放、放大后单指拖动、双击在 1x 与 2.5x 之间切换、点空白或 ✕ 关闭。
 */
const MIN_SCALE = 1
const MAX_SCALE = 6
const DOUBLE_TAP_SCALE = 2.5

const ImageViewer = ({ url, alt, onClose }: { url: string; alt: string; onClose: () => void }) => {
  const t = useTranslate()
  const [scale, setScale] = useState(1)
  const [offset, setOffset] = useState({ x: 0, y: 0 })
  const pointers = useRef(new Map<number, { x: number; y: number }>())
  const pinch = useRef<{ distance: number; scale: number } | null>(null)
  const lastTap = useRef(0)

  const clampScale = (value: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, value))

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const onPointerDown = (event: React.PointerEvent) => {
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()]
      pinch.current = { distance: Math.hypot(a.x - b.x, a.y - b.y), scale }
      return
    }
    if (pointers.current.size === 1) {
      const now = Date.now()
      if (now - lastTap.current < 300) {
        // 双击切换缩放
        setScale((current) => (current > 1 ? 1 : DOUBLE_TAP_SCALE))
        setOffset({ x: 0, y: 0 })
        lastTap.current = 0
        return
      }
      lastTap.current = now
    }
  }

  const onPointerMove = (event: React.PointerEvent) => {
    const previous = pointers.current.get(event.pointerId)
    if (!previous) {
      return
    }
    pointers.current.set(event.pointerId, { x: event.clientX, y: event.clientY })

    if (pointers.current.size === 2 && pinch.current) {
      const [a, b] = [...pointers.current.values()]
      const distance = Math.hypot(a.x - b.x, a.y - b.y)
      if (pinch.current.distance > 0) {
        setScale(clampScale((pinch.current.scale * distance) / pinch.current.distance))
      }
      return
    }

    if (pointers.current.size === 1 && scale > 1) {
      setOffset((current) => ({
        x: current.x + (event.clientX - previous.x),
        y: current.y + (event.clientY - previous.y),
      }))
    }
  }

  const onPointerUp = (event: React.PointerEvent) => {
    pointers.current.delete(event.pointerId)
    if (pointers.current.size < 2) {
      pinch.current = null
    }
  }

  return (
    <div
      className={styles.mask}
      role="dialog"
      aria-modal="true"
      aria-label={alt}
      onClick={() => {
        if (scale <= 1) {
          onClose()
        }
      }}
    >
      <button
        type="button"
        className={styles.close}
        aria-label={t('close')}
        onClick={(event) => {
          event.stopPropagation()
          onClose()
        }}
      >
        <IconCloseFill14 />
      </button>
      <img
        className={styles.image}
        src={url}
        alt={alt}
        draggable={false}
        style={{
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${scale})`,
          cursor: scale > 1 ? 'grab' : 'zoom-in',
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onClick={(event) => event.stopPropagation()}
      />
    </div>
  )
}

let host: HTMLElement | null = null
let root: Root | null = null

/** 打开全屏看图；再次调用会替换当前展示的图片 */
export const openImageViewer = (url: string, alt: string) => {
  if (!root) {
    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
  }
  const close = () => root?.render(null)
  root.render(<ImageViewer url={url} alt={alt} onClose={close} />)
}
