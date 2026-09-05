import { useUiStore } from '../stores/uiStore'
import { Icon } from './Icon'
import type { SearchResult } from '../../../shared/ipc'

function HighlightedText({ text, q }: { text: string; q: string }): React.ReactNode {
  if (!q || !text) return <>{text}</>
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const parts = text.split(new RegExp(`(${escaped})`, 'gi'))
  if (parts.length === 1) return <>{text}</>
  return (
    <>
      {parts.map((part, i) =>
        part.toLowerCase() === q.toLowerCase() ? (
          <mark key={i} className="console-highlight">{part}</mark>
        ) : (
          <span key={i}>{part}</span>
        )
      )}
    </>
  )
}

export function SearchResults(): React.ReactNode {
  const query = useUiStore((s) => s.searchQuery)
  const results = useUiStore((s) => s.searchResults)

  return (
    <div className="search-results-view">
      <div className="search-results-head">
        <Icon name="search" size={18} />
        <span className="search-results-title">「{query}」的搜索结果</span>
        <span className="search-results-count">{results.length} 条</span>
      </div>

      <div className="search-results-list">
        {results.map((r: SearchResult) => (
          <button
            key={r.id}
            type="button"
            className="search-result-item"
            onClick={() => r.sourcePath && window.oasis.files.reveal(r.sourcePath)}
          >
            <Icon name={r.type === 'image' ? 'image' : 'doc'} size={15} />
            <div className="search-result-body">
              <span className="search-result-title">
                <HighlightedText text={r.title} q={query} />
              </span>
              {r.snippet ? (
                <span className="search-result-snippet">
                  <HighlightedText text={r.snippet} q={query} />
                </span>
              ) : null}
            </div>
            <span className="search-result-score" title="相关性">{(r.score * 100).toFixed(0)}%</span>
          </button>
        ))}
        {results.length === 0 ? (
          <div className="search-results-empty">
            <Icon name="search" size={28} />
            <p>没有找到与「{query}」相关的内容</p>
          </div>
        ) : null}
      </div>
    </div>
  )
}
