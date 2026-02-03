# JustSay 待实现功能清单

## 完全未实现（UI有但后端功能缺失）

- [ ] **界面语言切换** - 需要添加i18n框架实现多语言支持
- [ ] **开机自动启动** - 需要调用 `app.setLoginItemSettings()` 实现系统自启动

## UI缺失（配置已定义但UI未暴露）

### 音频设置
- [ ] 音频设备选择 - `audio.device`
- [ ] 采样率设置 - `audio.sampleRate`

### 识别设置
- [ ] 识别语言选择 - `recognition.language`
- [ ] 自动标点开关 - `recognition.punctuation`
- [ ] OpenAI API 完整配置 - `recognition.api.*` (endpoint, apiKey, model)
- [ ] 本地模型 GPU/CPU 选择 - `recognition.local.device`
- [ ] 本地模型线程数 - `recognition.local.threads`

### 快捷键设置
- [ ] 快捷键模式（按住/切换） - `hotkey.mode`

### 输出设置
- [ ] 首字母大写 - `output.capitalize`

### 外观设置
- [ ] 指示器位置 - `ui.indicatorPosition`
- [ ] 指示器透明度 - `ui.indicatorOpacity`

## 已完成

- [x] **最小化到托盘** - 已修复 `src/main/index.ts:62-69`，现在根据 `general.minimizeToTray` 配置决定是隐藏还是退出
