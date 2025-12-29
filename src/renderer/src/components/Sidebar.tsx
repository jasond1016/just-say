import React from 'react'

interface SidebarProps {
    activeView: string
    onViewChange: (view: string) => void
}

export function Sidebar({ activeView, onViewChange }: SidebarProps): React.JSX.Element {
    return (
        <nav className="sidebar">
            <div className="sidebar__nav">
                <button
                    className={`nav-item ${activeView === 'ptt' ? 'active' : ''}`}
                    onClick={() => onViewChange('ptt')}
                >
                    <span className="nav-item__icon">🎤</span>
                    <span>按键说话</span>
                </button>
                <button
                    className={`nav-item ${activeView === 'meeting' ? 'active' : ''}`}
                    onClick={() => onViewChange('meeting')}
                >
                    <span className="nav-item__icon">📝</span>
                    <span>会议转录</span>
                </button>
                <div className="sidebar__divider" />
                <button
                    className={`nav-item ${activeView === 'settings' ? 'active' : ''}`}
                    onClick={() => onViewChange('settings')}
                >
                    <span className="nav-item__icon">⚙️</span>
                    <span>设置</span>
                </button>
            </div>
            <div className="sidebar__footer">
                <p className="sidebar__version">v1.0.0</p>
            </div>
        </nav>
    )
}
