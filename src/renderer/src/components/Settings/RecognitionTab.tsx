import React from 'react'
import { Button } from '@/components/ui/button'
import { useI18n } from '@/i18n/useI18n'
import type { TriggerKey } from '../../../../shared/hotkey'
import {
  FieldRow,
  ToggleRow,
  SectionLabel,
  StackedField,
  StatusBar,
  fieldClass,
  fullFieldClass
} from './settings-primitives'
import type {
  EngineOption,
  GroqModelType,
  LocalRecognitionMode,
  LocalTranscriptionProfile,
  ModelType,
  MicrophoneDevice,
  TranslationProvider
} from './settings-types'

export interface RecognitionTabProps {
  saving: boolean
  engine: EngineOption
  setEngine: (v: EngineOption) => void
  language: string
  setLanguage: (v: string) => void
  hotkey: TriggerKey
  setHotkey: (v: TriggerKey) => void
  modelSize: ModelType
  setModelSize: (v: ModelType) => void
  meetingIncludeMicrophone: boolean
  setMeetingIncludeMicrophone: (v: boolean) => void
  audioDevice: string
  setAudioDevice: (v: string) => void
  microphoneDevices: MicrophoneDevice[]
  microphoneDevicesLoading: boolean
  microphoneDevicesError: boolean
  selectedAudioDeviceUnavailable: boolean
  loadMicrophoneDeviceOptions: () => Promise<void>
  /* Local engine */
  isLocalEngine: boolean
  isSenseVoiceEngine: boolean
  localRecognitionMode: LocalRecognitionMode
  setLocalRecognitionMode: (v: LocalRecognitionMode) => void
  localTranscriptionProfile: LocalTranscriptionProfile
  setLocalTranscriptionProfile: (v: LocalTranscriptionProfile) => void
  localHoldMsInput: string
  setLocalHoldMsInput: (v: string) => void
  resolveLocalHoldMs: () => number
  isStreamingModeEnabled: boolean
  localServerMode: 'local' | 'remote'
  setLocalServerMode: (v: 'local' | 'remote') => void
  isRemoteLocalServer: boolean
  localServerHost: string
  setLocalServerHost: (v: string) => void
  localServerPortInput: string
  setLocalServerPortInput: (v: string) => void
  testingLocalServer: boolean
  localServerTestResult: boolean | null
  testRemoteLocalServer: () => Promise<void>
  /* Online engine */
  isOnlineEngine: boolean
  onlineApiKeyInput: string
  setOnlineApiKeyInput: (v: string) => void
  onlineApiKeyConfigured: boolean
  updatingOnlineApiKey: boolean
  clearOnlineApiKey: () => Promise<void>
  apiModel: string
  setApiModel: (v: string) => void
  sonioxModel: string
  setSonioxModel: (v: string) => void
  groqModel: GroqModelType
  setGroqModel: (v: GroqModelType) => void
  /* Translation */
  translationEnabled: boolean
  setTranslationEnabled: (v: boolean) => void
  meetingTranslationEnabled: boolean
  setMeetingTranslationEnabled: (v: boolean) => void
  anyTranslationEnabled: boolean
  targetLanguage: string
  setTargetLanguage: (v: string) => void
  translationProvider: TranslationProvider
  setTranslationProvider: (v: TranslationProvider) => void
  translationModel: string
  setTranslationModel: (v: string) => void
  translationEndpoint: string
  setTranslationEndpoint: (v: string) => void
  translationApiKeyInput: string
  setTranslationApiKeyInput: (v: string) => void
  translationApiKeyConfigured: boolean
  updatingTranslationApiKey: boolean
  clearTranslationApiKey: () => Promise<void>
}

export function RecognitionTab(props: RecognitionTabProps): React.JSX.Element {
  const { m } = useI18n()

  return (
    <div role="tabpanel" id="settings-panel-recognition" aria-labelledby="settings-tab-recognition" className="space-y-4">

      <SectionLabel>{m.settings.recognitionEngine}</SectionLabel>

      <FieldRow label={m.settings.recognitionEngine} htmlFor="s-engine">
        <select id="s-engine" className={fullFieldClass} value={props.engine} onChange={(e) => props.setEngine(e.target.value as EngineOption)}>
          <option value="local-faster-whisper">{m.settings.engineFasterWhisperLocal}</option>
          <option value="local-sensevoice">{m.settings.engineSenseVoiceLocal}</option>
          <option value="soniox">{m.settings.engineSoniox}</option>
          <option value="api">{m.settings.engineOpenAiApi}</option>
          <option value="groq">{m.settings.engineGroq}</option>
        </select>
      </FieldRow>

      <FieldRow label={m.settings.language} htmlFor="s-lang">
        <select id="s-lang" className={fullFieldClass} value={props.language} onChange={(e) => props.setLanguage(e.target.value)}>
          <option value="auto">{m.settings.autoDetect}</option>
          <option value="zh">{m.settings.chinese}</option>
          <option value="en">{m.settings.english}</option>
          <option value="ja">{m.settings.japanese}</option>
          <option value="ko">{m.settings.korean}</option>
        </select>
      </FieldRow>

      <FieldRow label={m.settings.hotkey} htmlFor="s-hotkey">
        <select id="s-hotkey" className={fullFieldClass} value={props.hotkey} onChange={(e) => props.setHotkey(e.target.value as TriggerKey)}>
          <option value="RCtrl">{m.settings.rightCtrl}</option>
          <option value="RAlt">{m.settings.rightAlt}</option>
          <option value="F13">F13</option>
          <option value="F14">F14</option>
        </select>
      </FieldRow>

      {props.isLocalEngine && !props.isSenseVoiceEngine && (
        <FieldRow label={m.settings.modelSize} htmlFor="s-model">
          <select id="s-model" className={fullFieldClass} value={props.modelSize} onChange={(e) => props.setModelSize(e.target.value as ModelType)}>
            <option value="tiny">tiny</option>
            <option value="base">base</option>
            <option value="small">small</option>
            <option value="medium">medium</option>
            <option value="large-v3">large-v3</option>
          </select>
        </FieldRow>
      )}

      <ToggleRow
        id="s-mic-label"
        label={m.settings.meetingIncludeMicrophone}
        description={m.settings.meetingIncludeMicrophoneDescription}
        checked={props.meetingIncludeMicrophone}
        onChange={props.setMeetingIncludeMicrophone}
      />

      <StackedField label={m.settings.microphoneDevice} htmlFor="s-audio-device">
        <div className="flex items-center gap-2">
          <select id="s-audio-device" className={`${fieldClass} min-w-0 flex-1`} value={props.audioDevice} onChange={(e) => props.setAudioDevice(e.target.value)} disabled={props.microphoneDevicesLoading}>
            <option value="default">{m.settings.defaultDevice}</option>
            {props.selectedAudioDeviceUnavailable ? <option value={props.audioDevice}>{m.settings.savedDeviceUnavailable}</option> : null}
            {props.microphoneDevices.filter((d) => d.id && d.id !== 'default').map((d, i) => (
              <option key={`${d.id}-${i}`} value={d.id}>{d.name}</option>
            ))}
          </select>
          <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-[11px] shrink-0" onClick={() => { void props.loadMicrophoneDeviceOptions() }} disabled={props.microphoneDevicesLoading || props.saving}>
            {props.microphoneDevicesLoading ? '…' : m.settings.refresh}
          </Button>
        </div>
      </StackedField>
      {props.microphoneDevicesError && <p className="text-[11px] text-muted-foreground pl-1">{m.settings.microphoneLoadFailed}</p>}

      {props.isLocalEngine && (
        <>
          <SectionLabel>Local Engine</SectionLabel>

          <FieldRow label={m.settings.localRecognitionMode} htmlFor="s-local-mode">
            <select id="s-local-mode" className={fullFieldClass} value={props.localRecognitionMode} onChange={(e) => props.setLocalRecognitionMode(e.target.value as LocalRecognitionMode)}>
              <option value="auto">{m.settings.localRecognitionModeAuto}</option>
              <option value="streaming">{m.settings.localRecognitionModeStreaming}</option>
              <option value="http_chunk">{m.settings.localRecognitionModeHttpChunk}</option>
            </select>
          </FieldRow>

          <StackedField label={m.settings.localTranscriptionProfile} htmlFor="s-local-profile" hint={m.settings.localTranscriptionProfileDescription}>
            <select id="s-local-profile" className={fullFieldClass} value={props.localTranscriptionProfile} onChange={(e) => props.setLocalTranscriptionProfile(e.target.value as LocalTranscriptionProfile)}>
              <option value="single_shot">{m.settings.localTranscriptionProfileSingleShot}</option>
              <option value="offline_segmented">{m.settings.localTranscriptionProfileOfflineSegmented}</option>
            </select>
          </StackedField>

          <StackedField label={m.settings.localHoldMs} htmlFor="s-hold-ms" hint={m.settings.localHoldMsDescription}>
            <input id="s-hold-ms" type="number" min={50} max={5000} className={`${fullFieldClass} disabled:opacity-40 w-[120px]`} value={props.localHoldMsInput} onChange={(e) => props.setLocalHoldMsInput(e.target.value)} onBlur={() => props.setLocalHoldMsInput(String(props.resolveLocalHoldMs()))} placeholder="260" disabled={!props.isStreamingModeEnabled} />
          </StackedField>

          <FieldRow label={m.settings.localServerMode} htmlFor="s-server-mode">
            <select id="s-server-mode" className={fullFieldClass} value={props.localServerMode} onChange={(e) => props.setLocalServerMode(e.target.value as 'local' | 'remote')}>
              <option value="local">{m.settings.localServerModeLocal}</option>
              <option value="remote">{m.settings.localServerModeRemote}</option>
            </select>
          </FieldRow>

          {props.isRemoteLocalServer && (
            <>
              <FieldRow label={m.settings.localServerHost} htmlFor="s-host">
                <input id="s-host" type="text" className={fullFieldClass} value={props.localServerHost} onChange={(e) => props.setLocalServerHost(e.target.value)} placeholder="127.0.0.1" />
              </FieldRow>
              <FieldRow label={m.settings.localServerPort} htmlFor="s-port">
                <input id="s-port" type="number" min={1} max={65535} className={fullFieldClass} value={props.localServerPortInput} onChange={(e) => props.setLocalServerPortInput(e.target.value)} placeholder="8765" />
              </FieldRow>
              <StatusBar
                text={props.localServerTestResult === null ? m.settings.localServerTestIdle : props.localServerTestResult ? m.settings.localServerTestSuccess : m.settings.localServerTestFailed}
                action={() => { void props.testRemoteLocalServer() }}
                actionLabel={props.testingLocalServer ? m.settings.localServerTesting : m.settings.testLocalServer}
                actionDisabled={props.testingLocalServer || props.saving}
              />
            </>
          )}
        </>
      )}

      {props.isOnlineEngine && (
        <>
          <SectionLabel>API</SectionLabel>

          <StackedField label={m.settings.recognitionApiKey} htmlFor="s-api-key">
            <input id="s-api-key" type="password" className={fullFieldClass} value={props.onlineApiKeyInput} onChange={(e) => props.setOnlineApiKeyInput(e.target.value)} placeholder={props.onlineApiKeyConfigured ? m.settings.storedKeyPlaceholder : m.settings.enterApiKey} />
          </StackedField>

          <FieldRow label={m.settings.modelType} htmlFor="s-model-type">
            {props.engine === 'groq' ? (
              <select id="s-model-type" className={fullFieldClass} value={props.groqModel} onChange={(e) => props.setGroqModel(e.target.value as GroqModelType)}>
                <option value="whisper-large-v3-turbo">whisper-large-v3-turbo</option>
                <option value="whisper-large-v3">whisper-large-v3</option>
              </select>
            ) : (
              <input id="s-model-type" type="text" className={fullFieldClass} value={props.engine === 'api' ? props.apiModel : props.sonioxModel} onChange={(e) => { if (props.engine === 'api') props.setApiModel(e.target.value); else if (props.engine === 'soniox') props.setSonioxModel(e.target.value) }} placeholder={props.engine === 'api' ? 'whisper-1' : 'stt-rt-v3'} />
            )}
          </FieldRow>

          <StatusBar
            text={`${m.settings.apiKeyStatus} ${props.onlineApiKeyConfigured ? m.settings.configured : m.settings.notConfigured}`}
            action={() => { void props.clearOnlineApiKey() }}
            actionLabel={m.settings.removeStoredKey}
            actionDisabled={!props.onlineApiKeyConfigured || props.updatingOnlineApiKey || props.saving}
          />
        </>
      )}

      <SectionLabel>Translation</SectionLabel>

      <ToggleRow id="s-t-ptt" label={m.settings.enableTranslationForPtt} description={m.settings.translationPttDescription} checked={props.translationEnabled} onChange={props.setTranslationEnabled} />
      <ToggleRow id="s-t-mtg" label={m.settings.enableTranslationForMeeting} description={m.settings.translationMeetingDescription} checked={props.meetingTranslationEnabled} onChange={props.setMeetingTranslationEnabled} />

      <FieldRow label={m.settings.targetLanguage} htmlFor="s-target-lang">
        <select id="s-target-lang" className={`${fullFieldClass} disabled:opacity-40`} value={props.targetLanguage} onChange={(e) => props.setTargetLanguage(e.target.value)} disabled={!props.anyTranslationEnabled}>
          <option value="zh">{m.settings.chineseSimplified}</option>
          <option value="en">{m.settings.english}</option>
          <option value="ja">{m.settings.japanese}</option>
          <option value="ko">{m.settings.korean}</option>
        </select>
      </FieldRow>

      {props.anyTranslationEnabled && (
        <>
          <FieldRow label={m.settings.translationProvider} htmlFor="s-t-provider">
            <select id="s-t-provider" className={fullFieldClass} value={props.translationProvider} onChange={(e) => props.setTranslationProvider(e.target.value as TranslationProvider)}>
              <option value="openai-compatible">{m.settings.openaiCompatible}</option>
            </select>
          </FieldRow>

          <FieldRow label={m.settings.translationModel} htmlFor="s-t-model">
            <input id="s-t-model" type="text" className={fullFieldClass} value={props.translationModel} onChange={(e) => props.setTranslationModel(e.target.value)} placeholder="gpt-4o-mini" />
          </FieldRow>

          <StackedField label={m.settings.translationEndpoint} htmlFor="s-t-endpoint">
            <input id="s-t-endpoint" type="text" className={fullFieldClass} value={props.translationEndpoint} onChange={(e) => props.setTranslationEndpoint(e.target.value)} placeholder="https://api.openai.com/v1" />
          </StackedField>

          <StackedField label={m.settings.translationApiKey} htmlFor="s-t-key">
            <input id="s-t-key" type="password" className={fullFieldClass} value={props.translationApiKeyInput} onChange={(e) => props.setTranslationApiKeyInput(e.target.value)} placeholder={props.translationApiKeyConfigured ? m.settings.storedKeyPlaceholder : m.settings.translationApiKeyPlaceholder} />
          </StackedField>

          <StatusBar
            text={`${m.settings.apiKeyStatus} ${props.translationApiKeyConfigured ? m.settings.configured : m.settings.notConfigured}`}
            action={() => { void props.clearTranslationApiKey() }}
            actionLabel={m.settings.removeStoredKey}
            actionDisabled={!props.translationApiKeyConfigured || props.updatingTranslationApiKey || props.saving}
          />
        </>
      )}
    </div>
  )
}
