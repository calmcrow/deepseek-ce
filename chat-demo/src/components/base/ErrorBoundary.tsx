import { Component, type ErrorInfo, type ReactNode } from 'react'
import { translate } from '../../i18n/index.js'

/**
 * 兜底错误边界：渲染期任何未捕获异常都会让 React 卸载整棵树（表现为整页白屏），
 * 这里把它换成一页可读的错误说明 + 重新加载按钮，保证界面不会只剩一片空白。
 * 只拦组件树内的抛出；事件回调和 Promise 里的异常仍走各自的 catch。
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  override componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('[render] uncaught error', error, info.componentStack)
  }

  override render() {
    const { error } = this.state
    if (!error) {
      return this.props.children
    }
    return (
      <div
        role="alert"
        style={{
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          minHeight: '100vh',
          padding: '32px 24px',
          boxSizing: 'border-box',
          textAlign: 'center',
          background: 'var(--dsw-alias-bg-base, #fff)',
          color: 'var(--dsw-alias-text-primary, #1a1a1a)',
          font: 'inherit',
        }}
      >
        <div style={{ fontSize: 18, fontWeight: 600 }}>{translate('crashTitle')}</div>
        <div style={{ maxWidth: 520, fontSize: 14, lineHeight: 1.7, opacity: 0.75 }}>
          {translate('crashDescription')}
        </div>
        <details style={{ maxWidth: 720, width: '100%', textAlign: 'left', fontSize: 12 }}>
          <summary style={{ cursor: 'pointer', opacity: 0.6 }}>error</summary>
          <pre
            style={{
              maxHeight: 240,
              overflow: 'auto',
              padding: 12,
              borderRadius: 8,
              background: 'rgba(127,127,127,0.12)',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
            }}
          >
            {`${error.name}: ${error.message}\n${error.stack ?? ''}`}
          </pre>
        </details>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            marginTop: 8,
            padding: '8px 20px',
            borderRadius: 999,
            border: '1px solid rgba(127,127,127,0.4)',
            background: 'transparent',
            color: 'inherit',
            font: 'inherit',
            fontSize: 14,
            cursor: 'pointer',
          }}
        >
          {translate('crashReload')}
        </button>
      </div>
    )
  }
}
