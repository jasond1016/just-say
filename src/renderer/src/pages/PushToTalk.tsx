import React from 'react'

interface PushToTalkProps {
    status: 'idle' | 'recording' | 'processing'
    hotkey: string
}

export function PushToTalk({ status, hotkey }: PushToTalkProps): React.JSX.Element {
    const statusText =
        status === 'idle' ? '准备就绪' : status === 'recording' ? '正在录音...' : '识别中...'

    return (
        <div className="content-view">
            <div className="content-header">
                <div className="content-header__title">
                    <span className="content-header__title-icon">🎤</span>
                    <h1>按键说话</h1>
                </div>
                <div className={`status-badge status-badge--${status === 'idle' ? 'idle' : 'active'}`}>
                    <span className="status-dot" />
                    <span>{status === 'idle' ? '待机中' : status === 'recording' ? '录音中' : '处理中'}</span>
                </div>
            </div>

            <div className="ptt-container">
                <div className={`ptt-status-card ${status === 'recording' ? 'active' : ''}`}>
                    <div className="ptt-icon">🎙️</div>
                    <div className="ptt-status-text">{statusText}</div>
                    <div className="ptt-shortcut">
                        按住 <span className="kbd">{hotkey}</span> 开始说话
                    </div>
                </div>

                <div className="ptt-instructions">
                    <h3>使用方法</h3>
                    <ul>
                        <li>按住快捷键开始录音</li>
                        <li>松开快捷键自动识别</li>
                        <li>识别结果自动插入到当前输入框</li>
                        <li>最小化后可在后台运行</li>
                    </ul>
                </div>
            </div>
        </div>
    )
}
