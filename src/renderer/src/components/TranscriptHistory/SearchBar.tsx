import React, { useState, useCallback } from 'react'
import './SearchBar.css'

interface SearchBarProps {
  onSearch: (query: string) => void
  onClear?: () => void
  placeholder?: string
}

export function SearchBar({ onSearch, onClear, placeholder = '搜索转录内容...' }: SearchBarProps): React.JSX.Element {
  const [query, setQuery] = useState('')

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value
    setQuery(value)
  }, [])

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault()
    if (query.trim()) {
      onSearch(query.trim())
    }
  }, [query, onSearch])

  const handleClear = useCallback(() => {
    setQuery('')
    onClear?.()
  }, [onClear])

  return (
    <form className="search-bar" onSubmit={handleSubmit}>
      <div className="search-bar__input-wrapper">
        <svg className="search-bar__icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.35-4.35" />
        </svg>
        <input
          type="text"
          className="search-bar__input"
          value={query}
          onChange={handleChange}
          placeholder={placeholder}
        />
        {query && (
          <button
            type="button"
            className="search-bar__clear"
            onClick={handleClear}
            aria-label="清除搜索"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        )}
      </div>
      <button type="submit" className="search-bar__submit">
        搜索
      </button>
    </form>
  )
}
