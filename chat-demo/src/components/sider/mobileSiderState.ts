import { create } from 'zustand'

/**
 * 移动端侧边栏抽屉。
 *
 * 打开方式默认是「从屏幕左边沿往右滑」，抽屉跟着手指走；也可以到「更多」里
 * 打开左上角按钮模式。点遮罩、切换会话或新建对话后关闭。
 *
 * `drag` 是拖拽过程中的实时宽度（px）：null 表示没有正在进行的拖拽，此时
 * 完全按 `open` 的开关状态渲染。
 */
export const useMobileSider = create(() => ({
  open: false,
  drag: null as number | null,
}))

export const openMobileSider = () => useMobileSider.setState({ open: true, drag: null })

export const closeMobileSider = () => useMobileSider.setState({ open: false, drag: null })

/** 拖拽中：传像素宽度；传 null 结束拖拽 */
export const setMobileSiderDrag = (drag: number | null) =>
  useMobileSider.setState({ drag })
