import React from 'react'

interface StatusBarProps {
    status: 'idle' | 'recording' | 'processing' | 'error'
    engine: string
    hotkey: string
}

export function StatusBar({ status, engine, hotkey }: StatusBarProps): React.JSX.Element {
    const statusIcon = status === 'error' ? '🔴' : status === 'idle' ? '🟢' : '🟡'
    const statusText =
        status === 'idle'
            ? '就绪'
            : status === 'recording'
                ? '录音中'
                : status === 'processing'
                    ? '处理中'
                    : '错误'

    return (
        <div className="status-bar">
            <div className="status-bar__left">
                <div className="status-bar__item">
                    <span>{statusIcon}</span>
                    <span>{statusText}</span>
                </div>
                <div className="status-bar__item">
                    <span>识别引擎:</span>
                    <span>{engine}</span>
                </div>
            </div>
            <div className="status-bar__right">
                <div className="status-bar__item">
                    <span>快捷键:</span>
                    <span className="kbd">{hotkey}</span>
                </div>
            </div>
        </div>
    )
}
