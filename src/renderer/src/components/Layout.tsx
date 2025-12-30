import React from 'react'

interface LayoutProps {
    children: React.ReactNode
    sidebar: React.ReactNode
    statusBar?: React.ReactNode
}

export function Layout({ children, sidebar, statusBar }: LayoutProps): React.JSX.Element {
    return (
        <div className="app">
            <header className="title-bar">
                <div className="title-bar__brand">
                    <span className="title-bar__brand-icon">🎙️</span>
                    <span>JustSay</span>
                </div>
            </header>

            <div className="main-container">
                {sidebar}
                <main className="content">{children}</main>
            </div>

            {statusBar}
        </div>
    )
}
