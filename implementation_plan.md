# Model Management UI Implementation Plan

## Goal

Implement a UI to manage local Faster-Whisper models, allowing users to download different model sizes (tiny, base, small, etc.) and switch between them.

## User Review Required

> [!IMPORTANT]
> Models will be stored in `userData/models` (e.g., `C:\Users\User\AppData\Roaming\JustSay\models`). This allows them to persist and be managed.

## Proposed Changes

### Python Service

#### [MODIFY] [whisper_service.py](file:///d:/my_projects/JustSay/python/whisper_service.py)

- Add `--download-root` argument.
- Pass `download_root` to `WhisperModel` constructor.
- Add a `--download-only` mode (optional, or just init model to trigger download).

### Electron Main Process

#### [MODIFY] [src/main/recognition/local.ts](file:///d:/my_projects/JustSay/src/main/recognition/local.ts)

- Update `LocalRecognizer` to pass `--download-root` to the python script.
- Set `download_root` to `app.getPath('userData')/models`.

#### [MODIFY] [src/main/index.ts](file:///d:/my_projects/JustSay/src/main/index.ts)

- Add IPC `get-model-list`: Scan the models directory and return available models.
- Add IPC `download-model`: Trigger the python script to download a specific model.

### Renderer (React)

#### [NEW] src/renderer/src/components/Settings/ModelManager.tsx

- UI to list models (Tiny, Base, Small, Medium, Large).
- Show "Download" button for missing models.
- Show "Active" badge for current model.
- Progress bar for downloads (simulated or real if possible).

#### [NEW] src/renderer/src/pages/Settings.tsx

- Main settings layout.
- Include `ModelManager` component.

#### [MODIFY] [src/renderer/src/App.tsx](file:///d:/my_projects/JustSay/src/renderer/src/App.tsx)

- Add routing or conditional rendering to show Settings page.

## Verification Plan

### Manual Verification

1.  **Check Settings UI**:
    - Launch app.
    - Verify Settings page is accessible (e.g., via Tray > Settings or default window).
    - Verify "Model Management" section exists.
2.  **Download Model**:
    - Select a new model (e.g., "base") and click Download.
    - Verify download starts (logs in terminal, UI feedback).
    - Verify model folder appears in `%APPDATA%\JustSay\models`.
    - Verify UI updates to "Downloaded".
3.  **Switch Model**:
    - Select the new model as active.
    - Perform a transcription test (Right Alt).
    - Verify logs show the new model being loaded.
