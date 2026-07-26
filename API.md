# ChatPulse Group Logic 接口说明

本扩展是 SillyTavern 前端第三方扩展，不提供独立聊天后端，也不要求手动连接 ChatPulse API。角色生成默认复用 SillyTavern 当前已连接的生成后端。

## 前端入口

- 扩展清单：`manifest.json`
- 主入口：`index.js`
- 样式：`style.css`
- 入口按钮：扩展加载后在 SillyTavern 页面内注入 ChatPulse 群聊入口
- 生成拦截器：`globalThis.chatPulseGroupLogicInterceptor`

`chatPulseGroupLogicInterceptor` 只在普通私聊生成时注入可共享的 ChatPulse 群聊记忆，不会创建或修改 SillyTavern 原生群聊。

## 本地数据

群聊数据存储在浏览器 localStorage：

```text
chatpulse_group_logic.local_groups.v1
```

新手引导状态与未完成的建群草稿单独存储：

```text
chatpulse_group_logic.onboarding.v1
```

引导记录包含 `status`、`stepId`、`createdGroupId` 和 `draft`。它不保存聊天内容；重新开始引导也不会删除已有群聊。

顶层结构：

```json
{
  "groups": [],
  "activeGroupId": "cpgl_..."
}
```

单个群聊核心字段：

```json
{
  "id": "cpgl_...",
  "name": "群聊名称",
  "members": ["character-avatar.png"],
  "userPersonaAvatar": "persona-avatar.png",
  "messages": [],
  "redPackets": [],
  "worldInfoBooks": [],
  "includeCharacterWorldInfo": true,
  "memory": {},
  "memoryPermissions": {}
}
```

说明：

- `members` 使用 SillyTavern 角色卡 avatar 文件名绑定角色。
- `userPersonaAvatar` 使用 SillyTavern 现有 user persona 头像文件名绑定本群用户人设。
- 可以创建多个群聊；所有群都保存在 `groups` 数组里。
- 不同 SillyTavern 角色卡可以同时出现在同一群的 `members` 中。
- 世界书不是必填项。`worldInfoBooks` 是群聊额外世界书；`includeCharacterWorldInfo` 开启时还会读取成员角色卡绑定世界书。
- 完整 Prompt、Raw Output、清理后输出和失败诊断只存放在页面内存中，不写入 localStorage，刷新后清除。

## 消息字段

普通消息：

```json
{
  "id": "msg_...",
  "timestamp": 1780000000000,
  "is_user": true,
  "name": "用户人设名",
  "avatar": "persona-avatar.png",
  "userPersonaAvatar": "persona-avatar.png",
  "mes": "消息正文"
}
```

角色消息：

```json
{
  "is_user": false,
  "name": "角色名",
  "avatar": "character-avatar.png",
  "mes": "消息正文"
}
```

系统消息：

```json
{
  "is_system": true,
  "name": "System",
  "mes": "[System] xxx 加入了群聊"
}
```

## 生成接口

群聊轮询使用 SillyTavern 前端的：

```js
generateRaw(options)
```

关键参数：

- `prompt`：只包含扩展显式构造的 `system` / `user` 消息
- `responseLength`：群管理面板里的输出上限
- `trimNames: false`：保留扩展自己的单角色输出清理流程

角色卡描述、性格、场景、首条消息、示例对话、系统提示、历史后置提示和 depth prompt 都由扩展显式加入。这样不会夹带 SillyTavern 当前打开的私聊角色或原生聊天历史。

如果当前 ST 没有连好模型/API，群聊发送也不会有角色回复；请先在 SillyTavern 原生连接设置里确认普通私聊能生成。

## 总结模型接口

长期记忆总结有两种模式：

- 当前模型：使用同一个 `generateRaw` 隔离接口和 SillyTavern 当前生成后端
- 自定义小模型：走 SillyTavern 的 Custom OpenAI-compatible 后端

自定义模型列表读取：

```text
POST /api/backends/chat-completions/status
```

请求体会包含：

```json
{
  "chat_completion_source": "custom",
  "custom_url": "https://api.example.com/v1"
}
```

API Key 使用 SillyTavern 全局 Custom API Key，不在本扩展里单独保存。

## 记忆权限与 User persona 边界

- 私聊 → 群聊：只读取与当前群 `userPersonaAvatar` 相同的角色私聊。
- 群聊 → 私聊：只有当前 SillyTavern 私聊使用同一 User persona 时才会注入。
- 其他群 → 当前群：源群和目标群的 User persona 必须相同。
- 任一端缺少明确的 persona avatar 时直接拒绝共享，不把两个空值视为同一身份。
- 上述身份条件满足后，仍需对应的 `memoryPermissions` 开关允许。
- 群聊 → 私聊会组合长期摘要与摘要游标之后的近期原文，避免只看到旧摘要。

## 调试插件接口

可选服务端调试插件目录：

```text
server-plugin/chatpulse_group_logic_debug
```

安装到 SillyTavern `plugins` 目录后，会提供：

```text
POST /api/plugins/chatpulse_group_logic_debug/log
```

前端点击、视口、错误探针会把调试信息 POST 到该接口，方便在 Termux/TUI 后台确认点击是否进入前端逻辑。没有安装调试插件时，扩展仍可正常使用。
