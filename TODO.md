# JustSay 待实现功能清单

## 完全未实现（UI有但后端功能缺失）

- [ ] **界面语言切换** - 需要添加i18n框架实现多语言支持
- [ ] **开机自动启动** - 需要调用 `app.setLoginItemSettings()` 实现系统自启动

## UI缺失（配置已定义但UI未暴露）

### 识别设置
- [ ] 本地模型 GPU/CPU 选择 - `recognition.local.device`
- [ ] 本地模型线程数 - `recognition.local.threads`

### 输出设置
- [x] 首字母大写 - `output.capitalize`

### 外观设置
- [ ] 指示器位置 - `ui.indicatorPosition`
- [ ] 指示器透明度 - `ui.indicatorOpacity`

## 已完成

