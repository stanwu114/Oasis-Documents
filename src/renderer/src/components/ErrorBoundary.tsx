import { Component, type ReactNode } from 'react'

/* ================================================================
   全局错误边界:渲染期异常不再白屏,显示错误与恢复入口
   (此前设置页任一初始化崩溃会把整棵树卸成白屏)
   ================================================================ */

interface Props {
  children: ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error): void {
    console.error('[ui] 渲染错误:', error)
  }

  render(): ReactNode {
    if (this.state.error) {
      return (
        <div className="search-results-empty" style={{ margin: '80px auto', maxWidth: 480, textAlign: 'center' }}>
          <p style={{ fontSize: 40, margin: 0 }}>:(</p>
          <p style={{ fontWeight: 600 }}>页面出错了</p>
          <p style={{ fontSize: 12.5, color: 'var(--fg-faint)', wordBreak: 'break-all' }}>
            {this.state.error.message || String(this.state.error)}
          </p>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'center', marginTop: 14 }}>
            <button type="button" className="btn primary" onClick={() => this.setState({ error: null })}>
              重试
            </button>
            <button type="button" className="btn ghost" onClick={() => window.location.reload()}>
              重新加载界面
            </button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}
