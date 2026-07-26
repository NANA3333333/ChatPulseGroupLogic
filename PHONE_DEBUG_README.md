# 手机调试连接说明

给下一个 GPT / Codex 接手时看。这个插件是 SillyTavern 扩展：

`C:\Users\Nana\Documents\SillyTavern\public\scripts\extensions\third-party\ChatPulseGroupLogic`

手机 Termux 里的用户扩展路径通常是：

`/data/data/com.termux/files/home/SillyTavern/data/default-user/extensions/ChatPulseGroupLogic`

## 已知环境

- Windows ADB 路径：
  `C:\Users\Nana\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe`
- 手机设备曾显示为：
  `53fea251	device`
- 手机 SillyTavern 在 Termux 里监听：
  `127.0.0.1:8000`
- 电脑访问手机 SillyTavern 使用端口转发：
  `http://127.0.0.1:18000/`
- 手机浏览器 DevTools 调试端口常转发到：
  `http://127.0.0.1:9222/json`

## 连接步骤

先确认手机已开启开发者选项和 USB 调试，并且数据线能传数据。

```powershell
& 'C:\Users\Nana\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe' devices
```

如果看到 `device`，说明 ADB 正常。

转发 SillyTavern：

```powershell
& 'C:\Users\Nana\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe' forward tcp:18000 tcp:8000
```

之后电脑浏览器打开：

`http://127.0.0.1:18000/`

## 连接手机浏览器 DevTools

先找手机浏览器的调试 socket：

```powershell
& 'C:\Users\Nana\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe' shell cat /proc/net/unix | Select-String -Pattern 'browser.*devtools|webview.*devtools'
```

常见结果类似：

`browser_webview_devtools_remote_26806`

然后转发：

```powershell
& 'C:\Users\Nana\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe' forward tcp:9222 localabstract:browser_webview_devtools_remote_26806
```

检查页面列表：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:9222/json' | ConvertTo-Json -Depth 5
```

找 URL 是 `http://127.0.0.1:8000/` 的 page，然后用它的 `webSocketDebuggerUrl` 做 CDP 调试。

## 常用检查

检查电脑转发看到的插件版本：

```powershell
Invoke-RestMethod -Uri 'http://127.0.0.1:18000/scripts/extensions/third-party/ChatPulseGroupLogic/manifest.json' | ConvertTo-Json -Depth 4
```

目前应至少是：

`0.3.0`

检查本地代码语法：

```powershell
node --check 'C:\Users\Nana\Documents\SillyTavern\public\scripts\extensions\third-party\ChatPulseGroupLogic\index.js'
node --check 'C:\Users\Nana\Documents\SillyTavern\public\scripts\extensions\third-party\ChatPulseGroupLogic\bootstrap.js'
```

## 手机端更新插件

如果代码已推到 GitHub，可以在手机 SillyTavern 页面上下文里调用 `/api/extensions/update`。需要 CSRF token，示例逻辑：

```js
const token = await fetch('/csrf-token').then(r => r.json()).then(x => x.token);
await fetch('/api/extensions/update', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token },
  body: JSON.stringify({ extensionName: 'ChatPulseGroupLogic', global: false }),
});
```

更新后硬刷新手机页面，确认加载的是新版：

- `bootstrap.js?v=版本号`
- `style.css?v=版本号`
- `manifest.json` 的 `version`

## 重要历史问题

1. 之前手机端打不开，是因为旧的全局扩展副本覆盖了新版用户扩展。
   旧路径是：
   `public/scripts/extensions/third-party/ChatPulseGroupLogic`

2. 如果手机端更新后仍加载旧版，检查是否存在全局副本。必要时删除旧全局副本，只保留：
   `data/default-user/extensions/ChatPulseGroupLogic`

3. TUI 里常见这个报错：
   `SpeechSynthesisUtterance is not defined`
   这是 SillyTavern 自带 TTS 在手机浏览器里的报错，不是本插件错误。

4. `0.1.18` 起已去掉手机端屏幕中间的可拖动浮动入口。手机端应通过顶部扩展入口或扩展设置入口打开群聊弹窗。

## 截图

可以用 ADB 截手机当前屏幕：

```powershell
cmd /c ""C:\Users\Nana\AppData\Local\Microsoft\WinGet\Packages\Google.PlatformTools_Microsoft.Winget.Source_8wekyb3d8bbwe\platform-tools\adb.exe" exec-out screencap -p > "C:\Users\Nana\Documents\Codex\phone-debug.png""
```
