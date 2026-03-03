declare module 'uiohook-napi' {
  export interface UiohookKeyboardEvent {
    keycode: number
  }

  export interface UiohookInstance {
    on(
      event: 'keydown' | 'keyup',
      listener: (event: UiohookKeyboardEvent) => void | Promise<void>
    ): UiohookInstance
    start(): void
    stop(): void
    keyTap(keycode: number): void
  }

  export const uIOhook: UiohookInstance

  export const UiohookKey: {
    Escape: number
    F13: number
    F14: number
    CtrlRight: number
    AltRight: number
    [key: string]: number
  }
}
