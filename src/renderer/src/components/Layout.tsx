import React from 'react'

interface LayoutProps {
    children: React.ReactNode
    sidebar: React.ReactNode
    statusBar?: React.ReactNode
}

export function Layout({ children, sidebar, statusBar }: LayoutProps): React.JSX.Element {
    return (
        <div className="app">
            <div className="title-bar">
                <div className="title-bar__brand">
                    <span className="title-bar__brand-icon">🎙️</span>
                    <span>JustSay</span>
                </div>
                <div className="title-bar__controls">
                    <button className="title-bar__btn title-bar__btn--minimize" />
                    <button className="title-bar__btn title-bar__btn--maximize" />
                    <button className="title-bar__btn title-bar__btn--close" />
                </div>
            </div>

            <div className="main-container">
                {sidebar}
                <main className="content">{children}</main>
            </div>

            {statusBar && statusBar}
        </div>
    )
}
