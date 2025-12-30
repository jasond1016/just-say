import React from 'react'

interface SidebarProps {
    activeView: string
    onViewChange: (view: string) => void
}

const navItems = [
    { id: 'ptt', icon: '🎤', label: '按键说话' },
    { id: 'meeting', icon: '📝', label: '会议转录' },
]

export function Sidebar({ activeView, onViewChange }: SidebarProps): React.JSX.Element {
    return (
        <nav className="sidebar">
            <div className="sidebar__nav">
                {navItems.map((item, index) => (
                    <button
                        key={item.id}
                        className={`nav-item ${activeView === item.id ? 'active' : ''} stagger-${index + 1}`}
                        onClick={() => onViewChange(item.id)}
                        style={{ animationFillMode: 'backwards' }}
                    >
                        <span className="nav-item__icon">{item.icon}</span>
                        <span>{item.label}</span>
                    </button>
                ))}

                <div className="sidebar__divider" />

                <button
                    className={`nav-item ${activeView === 'settings' ? 'active' : ''} stagger-3`}
                    onClick={() => onViewChange('settings')}
                    style={{ animationFillMode: 'backwards' }}
                >
                    <span className="nav-item__icon">⚙️</span>
                    <span>设置</span>
                </button>
            </div>

            <footer className="sidebar__footer">
                <p className="sidebar__version">v1.0.0</p>
            </footer>
        </nav>
    )
}
