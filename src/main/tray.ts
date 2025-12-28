import { Tray, Menu, nativeImage, app, NativeImage } from 'electron'
import { join } from 'path'

let tray: Tray | null = null

export interface TrayCallbacks {
  showSettings: () => void
  showMeetingWindow: () => void
}

export function setupTray(callbacks: TrayCallbacks): Tray {
  // Create tray icon - use resources icon
  const iconPath = join(__dirname, '../../resources/icon.png')

  let icon: NativeImage
  try {
    icon = nativeImage.createFromPath(iconPath)
    if (icon.isEmpty()) {
      icon = createDefaultIcon()
    }
  } catch {
    icon = createDefaultIcon()
  }

  // Resize for tray (16x16 on Windows)
  icon = icon.resize({ width: 16, height: 16 })

  tray = new Tray(icon)
  tray.setToolTip('JustSay - 语音转录')

  const contextMenu = Menu.buildFromTemplate([
    {
      label: 'JustSay',
      enabled: false
    },
    { type: 'separator' },
    {
      label: '🎙️ 会议转录',
      click: (): void => {
        callbacks.showMeetingWindow()
      }
    },
    { type: 'separator' },
    {
      label: '设置',
      click: (): void => {
        callbacks.showSettings()
      }
    },
    { type: 'separator' },
    {
      label: '退出',
      click: (): void => {
        app.quit()
      }
    }
  ])

  tray.setContextMenu(contextMenu)

  // Double click to show settings
  tray.on('double-click', () => {
    callbacks.showSettings()
  })

  return tray
}

function createDefaultIcon(): NativeImage {
  // Create a simple 16x16 teal circle icon as fallback
  const size = 16
  const canvas = Buffer.alloc(size * size * 4)

  for (let i = 0; i < size * size; i++) {
    const x = i % size
    const y = Math.floor(i / size)
    const centerX = size / 2
    const centerY = size / 2
    const distance = Math.sqrt((x - centerX) ** 2 + (y - centerY) ** 2)

    if (distance < size / 2 - 1) {
      canvas[i * 4] = 0 // R
      canvas[i * 4 + 1] = 180 // G
      canvas[i * 4 + 2] = 180 // B
      canvas[i * 4 + 3] = 255 // A
    } else {
      canvas[i * 4 + 3] = 0
    }
  }

  return nativeImage.createFromBuffer(canvas, { width: size, height: size })
}

export function updateTrayStatus(status: 'idle' | 'recording' | 'processing'): void {
  if (!tray) return

  const statusText: Record<string, string> = {
    idle: 'JustSay - 待机中',
    recording: 'JustSay - 录音中...',
    processing: 'JustSay - 识别中...'
  }

  tray.setToolTip(statusText[status] || statusText.idle)
}
