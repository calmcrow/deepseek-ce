import { useEffect } from 'react'
import {
  closeMobileSider,
  openMobileSider,
  setMobileSiderDrag,
  useMobileSider,
} from './mobileSiderState.js'

/** 左边沿多宽的手指落点算「从边缘滑入」 */
const EDGE_PX = 28
/** 判定为水平拖拽的最小位移，避免和纵向滚动抢手势 */
const ACTIVATE_PX = 8
/** 松手时超过这个比例就算打开 */
const OPEN_RATIO = 0.4
/** 快速一甩也认，单位 px/ms */
const FLING_VELOCITY = 0.4

/** 抽屉宽度取自 CSS（300px，窄屏时留 48px），拖拽比例要跟它一致 */
const drawerWidth = () => Math.min(300, window.innerWidth - 48)

/**
 * 移动端侧栏的手势：
 *   - 关着的时候，从屏幕左边沿往右拖，抽屉跟手滑出，松手过 40% 就打开
 *   - 开着的时候，往左拖可以拖回去关掉
 *   - 点遮罩照旧关闭
 * 只接管水平方向明确的手势，纵向滚动和输入框里的选择不受影响。
 */
export const useSiderSwipe = (enabled: boolean) => {
  useEffect(() => {
    if (!enabled) {
      return
    }
    let mode: 'open' | 'close' | null = null
    let startX = 0
    let startY = 0
    let startDrag = 0
    let lastX = 0
    let lastAt = 0
    let velocity = 0
    let activated = false

    const onStart = (event: TouchEvent) => {
      if (event.touches.length !== 1) {
        return
      }
      const touch = event.touches[0]
      const { open } = useMobileSider.getState()
      const width = drawerWidth()
      if (!open) {
        // 只有贴着左边沿按下才算「拉出抽屉」，避免和正文左右滑动冲突
        if (touch.clientX > EDGE_PX) {
          return
        }
        mode = 'open'
        startDrag = 0
      } else if (touch.clientX <= width) {
        mode = 'close'
        startDrag = width
      } else {
        return
      }
      startX = touch.clientX
      startY = touch.clientY
      lastX = touch.clientX
      lastAt = event.timeStamp
      velocity = 0
      activated = false
    }

    const onMove = (event: TouchEvent) => {
      if (mode === null || event.touches.length !== 1) {
        return
      }
      const touch = event.touches[0]
      const dx = touch.clientX - startX
      const dy = touch.clientY - startY
      if (!activated) {
        // 先看方向：明显是纵向滚动就放手，别拦着列表滑
        if (Math.abs(dy) > Math.abs(dx)) {
          mode = null
          return
        }
        if (Math.abs(dx) < ACTIVATE_PX) {
          return
        }
        activated = true
      }
      // 确认是横滑后锁住页面，避免拖抽屉时正文跟着横向漂移
      if (event.cancelable) {
        event.preventDefault()
      }
      const width = drawerWidth()
      const now = event.timeStamp
      if (now > lastAt) {
        velocity = (touch.clientX - lastX) / (now - lastAt)
        lastX = touch.clientX
        lastAt = now
      }
      setMobileSiderDrag(Math.max(0, Math.min(width, startDrag + dx)))
    }

    const onEnd = () => {
      if (mode === null) {
        return
      }
      const width = drawerWidth()
      const drag = useMobileSider.getState().drag ?? (mode === 'open' ? 0 : width)
      const ratio = drag / width
      const flung = Math.abs(velocity) >= FLING_VELOCITY
      const shouldOpen = mode === 'open' ? ratio > OPEN_RATIO || (flung && velocity > 0) : ratio > 1 - OPEN_RATIO || (flung && velocity > 0)
      setMobileSiderDrag(null)
      if (shouldOpen) {
        openMobileSider()
      } else {
        closeMobileSider()
      }
      mode = null
      activated = false
    }

    document.addEventListener('touchstart', onStart, { passive: true })
    document.addEventListener('touchmove', onMove, { passive: false })
    document.addEventListener('touchend', onEnd, { passive: true })
    document.addEventListener('touchcancel', onEnd, { passive: true })
    return () => {
      document.removeEventListener('touchstart', onStart)
      document.removeEventListener('touchmove', onMove)
      document.removeEventListener('touchend', onEnd)
      document.removeEventListener('touchcancel', onEnd)
      setMobileSiderDrag(null)
    }
  }, [enabled])
}
