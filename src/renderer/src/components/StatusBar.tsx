import React from 'react'

interface StatusBarProps {
    status: 'idle' | 'recording' | 'processing' | 'error'
    engine: string
    hotkey: string
}

const statusConfig = {
    idle: { icon: '●', text: '就绪', className: 'idle' },
    recording: { icon: '●', text: '录音中', className: 'recording' },
    processing: { icon: '●', text: '处理中', className: 'processing' },
    error: { icon: '●', text: '错误', className: 'error' },
}

const engineIcons: Record<string, string> = {
    Soniox: '⚡',
    OpenAI: '🤖',
    Local: '💻',
}

export function StatusBar({ status, engine, hotkey }: StatusBarProps): React.JSX.Element {
    const { icon, text, className } = statusConfig[status]
    const engineIcon = engineIcons[engine] || '🔧'

    return (
        <footer className="status-bar">
            <div className="status-bar__left">
                <div className={`status-bar__item status-bar__item--status ${className}`}>
                    <span>{icon}</span>
                    <span>{text}</span>
                </div>
                <div className="status-bar__item">
                    <span>{engineIcon}</span>
                    <span>{engine}</span>
                </div>
            </div>
            <div className="status-bar__right">
                <div className="status-bar__item">
                    <span>快捷键</span>
                    <kbd className="kbd">{hotkey}</kbd>
                </div>
            </div>
        </footer>
    )
}
