import { create } from 'zustand'

/** 移动端侧边栏抽屉：顶栏菜单按钮打开，点遮罩、切换会话或开启新对话后关闭 */
export const useMobileSider = create(() => ({ open: false }))

export const openMobileSider = () => {
  // 打开抽屉的同时清掉消息里可能残留的选区，别让选择工具条跟着进来
  window.getSelection()?.removeAllRanges()
  useMobileSider.setState({ open: true })
}

export const closeMobileSider = () => useMobileSider.setState({ open: false })
