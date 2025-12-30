import { Tray, Menu, nativeImage, app, NativeImage } from 'electron'

let tray: Tray | null = null

export interface TrayCallbacks {
  showMainWindow: () => void
}

export function setupTray(callbacks: TrayCallbacks): Tray {
  // Create branded tray icon
  const icon = createBrandedIcon()

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
        app.quit()
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

/**
 * Creates a branded JustSay icon with purple-pink gradient and microphone
 */
function createBrandedIcon(): NativeImage {
  const size = 64 // Create at higher resolution for better quality
  const canvas = Buffer.alloc(size * size * 4)

  const centerX = size / 2
  const centerY = size / 2
  const radius = size / 2 - 2

  // Colors from our design system
  const purple = { r: 139, g: 92, b: 246 } // #8b5cf6
  const pink = { r: 236, g: 72, b: 153 } // #ec4899

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const dx = x - centerX
      const dy = y - centerY
      const distance = Math.sqrt(dx * dx + dy * dy)

      if (distance <= radius) {
        // Create gradient from top-left to bottom-right
        const gradientPos = (x + y) / (size * 2)
        const r = Math.round(purple.r + (pink.r - purple.r) * gradientPos)
        const g = Math.round(purple.g + (pink.g - purple.g) * gradientPos)
        const b = Math.round(purple.b + (pink.b - purple.b) * gradientPos)

        // Draw microphone shape (scaled for 64px)
        const micWidth = size * 0.25
        const micHeight = size * 0.35
        const micTop = centerY - size * 0.25

        const inMicBody =
          x >= centerX - micWidth / 2 &&
          x <= centerX + micWidth / 2 &&
          y >= micTop &&
          y <= micTop + micHeight

        // Rounded top for mic body
        const micBodyRadius = micWidth / 2
        const inMicRoundTop = Math.sqrt((x - centerX) ** 2 + (y - micTop) ** 2) <= micBodyRadius

        const standWidth = size * 0.08
        const standTop = micTop + micHeight + size * 0.08
        const standHeight = size * 0.15
        const inMicStand =
          x >= centerX - standWidth / 2 &&
          x <= centerX + standWidth / 2 &&
          y >= standTop &&
          y <= standTop + standHeight

        const baseWidth = size * 0.3
        const baseHeight = size * 0.06
        const baseTop = standTop + standHeight
        const inMicBase =
          x >= centerX - baseWidth / 2 &&
          x <= centerX + baseWidth / 2 &&
          y >= baseTop &&
          y <= baseTop + baseHeight

        if (inMicBody || inMicRoundTop || inMicStand || inMicBase) {
          // White microphone
          canvas[i] = 255 // R
          canvas[i + 1] = 255 // G
          canvas[i + 2] = 255 // B
          canvas[i + 3] = 255 // A
        } else {
          // Gradient background
          canvas[i] = r // R
          canvas[i + 1] = g // G
          canvas[i + 2] = b // B
          canvas[i + 3] = 255 // A
        }
      } else {
        // Transparent outside circle
        canvas[i + 3] = 0
      }
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
