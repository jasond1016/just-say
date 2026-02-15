/**
 * 热键（按住说话）配置与显示文案
 *
 * 注意：此文件需可同时被 main/renderer 引用（不要引入 Node-only 依赖）
 */

export type TriggerKey = 'RAlt' | 'RCtrl' | 'F13' | 'F14'

export const DEFAULT_TRIGGER_KEY: TriggerKey = 'RCtrl'

export const TRIGGER_KEY_LABELS: Record<TriggerKey, string> = {
  RAlt: 'Right Alt',
  RCtrl: 'Right Ctrl',
  F13: 'F13',
  F14: 'F14'
}

export function normalizeTriggerKey(value: unknown): TriggerKey {
  if (value === 'RAlt' || value === 'RCtrl' || value === 'F13' || value === 'F14') {
    return value
  }
  return DEFAULT_TRIGGER_KEY
}

export function getTriggerKeyLabel(value: unknown): string {
  return TRIGGER_KEY_LABELS[normalizeTriggerKey(value)]
}
