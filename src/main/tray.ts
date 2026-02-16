import { Tray, Menu, nativeImage } from 'electron'
import { join } from 'path'

let tray: Tray | null = null

export interface TrayCallbacks {
  showMainWindow: () => void
  quitApp: () => void
}

export function setupTray(callbacks: TrayCallbacks): Tray {
  // Load icon from resources
  const iconPath = join(__dirname, '../../resources/tray/tray-32.png')
  const icon = nativeImage.createFromPath(iconPath)

  // Resize for tray (16x16 on Windows, 22x22 on some Linux)
  const size = process.platform === 'linux' ? 22 : 16
  const resizedIcon = icon.resize({ width: size, height: size })

  tray = new Tray(resizedIcon)
  tray.setToolTip('JustSay - 语音转录')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'JustSay',
      enabled: false
    },
    { type: 'separator' },
    {
      label: '打开主窗口',
      click: (): void => {
        callbacks.showMainWindow()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: (): void => {
        callbacks.quitApp()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  // Click to show main window
  tray.on('click', () => {
    callbacks.showMainWindow()
  })

  // Double click also shows main window
  tray.on('double-click', () => {
    callbacks.showMainWindow()
  })

  return tray
}

export function updateTrayStatus(status: 'idle' | 'recording' | 'processing' | 'meeting'): void {
  if (!tray) return

  const statusText: Record<string, string> = {
    idle: 'JustSay - 待机中',
    recording: 'JustSay - 录音中...',
    processing: 'JustSay - 识别中...',
    meeting: 'JustSay - 会议转录中...'
  }

  tray.setToolTip(statusText[status] || statusText.idle)
}

export function setTrayTooltip(text: string): void {
  if (!tray) return
  tray.setToolTip(text)
}
