# ChatPulse Group Logic

一个用于 SillyTavern 的第三方扩展，提供独立于 SillyTavern 原生群聊的微信式群聊入口与窗口，并保留 ChatPulse 群聊轮询逻辑。

这个扩展适合想要在 SillyTavern 里使用更接近即时通讯群聊体验的用户：它会复用 SillyTavern 的角色卡、世界书、用户人设和生成 API，但群聊列表、群聊窗口、消息记录和群聊控制都由扩展自己管理。

## 实机截图与测试数据

以下截图来自 SillyTavern 1.18.0 中实际加载的扩展和 AIRP 角色扮演测试数据，不是静态 UI 稿。

### 电脑端

Windows 微信式三栏布局：功能栏、群列表、聊天区与底部输入框。

![电脑端 AIRP 群聊实机截图](docs/screenshots/wechat-desktop-airp.jpg)

### 手机端

手机端使用微信式全屏群聊，左上角返回群列表，右上角 `···` 打开聊天信息。

<table>
  <tr>
    <th>实际群聊</th>
    <th>聊天信息与快捷操作</th>
  </tr>
  <tr>
    <td><img src="docs/screenshots/wechat-mobile-airp.jpg" alt="手机端 AIRP 群聊实机截图" width="390"></td>
    <td><img src="docs/screenshots/wechat-mobile-chat-info.jpg" alt="手机端聊天信息页面" width="390"></td>
  </tr>
</table>

### 游戏式新手引导

首次进入会用遮罩、高亮和箭头带用户真实点击控件，并完成第一个群聊的创建。

| 指向新建群聊按钮 | 指向群名称输入框 |
|---|---|
| ![箭头指向新建群聊按钮](docs/screenshots/onboarding-create.jpg) | ![箭头指向群名称输入框](docs/screenshots/onboarding-name.jpg) |

### AIRP 记忆连续性

实际测试覆盖群聊 → 私聊、不同 User persona 隔离，以及同一 User persona 授权后的跨群记忆。

![AIRP 跨窗口记忆测试数据](docs/screenshots/airp-continuity.png)

最终发布闸门合计 `109 / 109` 项通过；完整场景、角色评分和调用说明见 [测试报告](TEST_REPORT.md)。

## 功能

- 首次使用自动启动游戏式新手引导，用高亮和箭头带用户实际创建第一个群聊
- 内置帮助中心（电脑端 `?`；手机端 `··· → 使用帮助`），可随时查看按钮图鉴、回复规则、记忆权限和排错说明
- 新手引导支持暂停、继续、跳过、重新开始，并保存未完成的建群草稿
- 电脑端采用 Windows 微信式三栏布局，手机端采用微信式群列表与全屏对话切换
- 独立群聊入口和群聊窗口，已有多个群时会全部保留在会话列表中
- 创建群聊、拉人入群、踢人出群、删除群聊
- 同一群可混合不同 SillyTavern 角色卡，并可同时保留多个独立群
- 成员加入/移出时插入系统公告，并触发群成员反应
- 用户无 `@` 发言时，群成员随机排序轮询回复
- 用户 `@角色` 时，被 @ 的角色优先回复，其余成员继续随机轮询
- 角色 `@角色` 时，被 @ 的角色会在本轮后单独回应
- ChatPulse 风格 `@` 成员选择弹窗
- 输入栏表情入口和圆形 `＋` 更多/红包入口
- 用户发红包弹窗，支持拼手气红包和普通红包
- 角色可通过隐藏标签 `[REDPACKET_SEND:type|amount|count|note]` 发红包
- 红包发出后在队列空闲时触发群成员反应；生成中则顺延到下一次消息
- 本地红包记录和领取记录
- 独立群聊弹窗内的预设、正则、API 间隔设置
- 私聊和其他本地群聊记录注入，默认按 User persona 严格隔离
- 群共享长期摘要，支持 R 原文窗口和 S 触发阈值
- 长期摘要可选择当前模型或自定义 OpenAI-compatible 小模型 endpoint/model，支持读取 `/models` 下拉选择
- 私聊读取本群记忆、群聊读取角色私聊或其他群记忆的独立权限开关
- 回复前自动总结窗口外未摘要消息，失败时中止本轮并提示重试
- 运行队列面板，可查看当前轮询进度并请求跳过/停止
- 可调 API 初始间隔、递增间隔和最大退避间隔，减少撞速率上限
- 当前页面会话内的最近输入/输出与失败诊断，刷新即清除，不把完整 Prompt 写入 localStorage
- 清空队列、清空调试记录、清空当前群聊历史

## 安装

把本仓库克隆或复制到 SillyTavern 的第三方扩展目录：

```text
SillyTavern/public/scripts/extensions/third-party/ChatPulseGroupLogic
```

然后重启或刷新 SillyTavern，在扩展面板里启用 `ChatPulse Group Logic`。

Termux 手机本地部署推荐直接安装到当前用户扩展目录。SillyTavern 的 local 扩展实际目录是 `data/default-user/extensions/ChatPulseGroupLogic`，浏览器访问时才会映射为 `/scripts/extensions/third-party/ChatPulseGroupLogic/...`：

```bash
curl -fsSL https://raw.githubusercontent.com/NANA3333333/ChatPulseGroupLogic/main/install-termux.sh | bash
```

脚本会同步代码到正确的 local 扩展目录，并从 `settings.json` 的 `disabledExtensions` 里移除本插件，避免“已安装但前端不执行”的状态。

### 手机端点击调试

如果手机端点不开入口，可以把仓库里的调试服务端插件复制到 SillyTavern 的 `plugins` 目录，然后重启 SillyTavern：

```bash
mkdir -p ~/SillyTavern/plugins
cp -r ~/SillyTavern/public/scripts/extensions/third-party/ChatPulseGroupLogic/server-plugin/chatpulse_group_logic_debug ~/SillyTavern/plugins/chatpulse_group_logic_debug
```

启动成功后，Termux/TUI 会看到：

```text
[CPGL DEBUG] Server debug plugin initialized. POST /api/plugins/chatpulse_group_logic_debug/log
```

之后点击 ChatPulse 群聊入口、群聊窗口里的按钮或输入框，后台会打印 `[CPGL DEBUG ...]` 日志，用来确认点击是否真的进入前端逻辑、窗口尺寸是否异常、以及是否有 JS 报错。

## 使用

1. 打开 SillyTavern。
2. 启用 `ChatPulse Group Logic`。
3. 首次进入时跟随屏幕上的箭头完成新手任务。
4. 创建一个群聊，选择本群使用的 User 人设，并选择至少一位成员。
5. 在群聊窗口里发送消息；电脑端点击右上角 `?`，手机端点击 `··· → 使用帮助`，可随时重看说明或重新开始引导。

扩展没有第二套聊天 API 配置：它直接使用 SillyTavern 当前连接的模型/API。世界书也是可选项，没有世界书时仍会使用完整角色卡、User 人设与群聊上下文生成。

更多接口和项目结构见：

- [接口说明](API.md)
- [项目说明](PROJECT.md)
- [完整使用说明](USER_GUIDE.md)

## 群聊逻辑

- **无 @ 发言**：群成员随机排序，依次自然接话。
- **用户 @ 角色**：被 @ 的角色优先回复，然后其他成员随机接话。
- **角色 @ 角色**：本轮结束后，被 @ 的角色会单独回应这条 @；开启“禁止 AI 因互相 @ 追加回复”后不会追加。
- **用户发红包**：红包卡片立即出现在聊天区，随后触发群成员反应。
- **角色发红包**：模型输出隐藏标签后，扩展会创建红包卡片并触发红包反应链。
- **拉人/踢人**：扩展会插入系统公告，并让群成员自然反应。

## 红包标签

角色如果要发红包，可以在回复末尾输出隐藏标签：

```text
[REDPACKET_SEND:lucky|50|5|新年快乐]
[REDPACKET_SEND:equal|100|4|恭喜发财]
```

说明：

- `lucky`：拼手气红包
- `equal`：普通红包
- 第二项：总金额
- 第三项：红包份数
- 第四项：留言

扩展会解析这个标签，创建红包卡片，并在显示消息时过滤隐藏标签。

## 说明

- 群聊数据存储在浏览器 `localStorage`。
- 完整 Prompt、模型输出和失败诊断只保留在当前页面会话，刷新后清除。
- 不创建、不修改 SillyTavern 原生群聊。
- 使用 SillyTavern 当前角色卡。
- 每个群聊可以绑定一个 SillyTavern 已有 User 人设。
- 跨私聊、跨群记忆只会在两端都有明确且相同的 User 人设时共享，仍需对应权限开关允许。
- 允许 SillyTavern 世界书和用户人设参与角色生成。
- 世界书不是必填项；可只使用角色卡、群历史和 User 人设。
- 不依赖 ChatPulse 后端、数据库、城市模拟、向量记忆或情绪系统。
- 这个扩展主要复制和移植 ChatPulse 群聊中适合在 SillyTavern 前端独立运行的部分逻辑。

## 开发

核心文件：

- `manifest.json`
- `index.js`
- `style.css`

语法检查：

```bash
node --check index.js
```

## 许可证

Creative Commons Attribution 4.0 International，简称 CC BY 4.0。

完整协议见 `LICENSE`，或访问：

```text
https://creativecommons.org/licenses/by/4.0/
```
