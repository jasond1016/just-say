import { ElectronAPI } from '@electron-toolkit/preload'

interface JustSayAPI {
  getConfig: () => Promise<unknown>
  setConfig: (config: unknown) => Promise<void>
  showSettings: () => Promise<void>
  quit: () => Promise<void>
  onRecordingState: (callback: (state: { recording: boolean; processing?: boolean }) => void) => void
  removeAllListeners: (channel: string) => void
}

declare global {
  interface Window {
    electron: ElectronAPI
    api: JustSayAPI
  }
}
