# ChatPulse Group Logic 项目说明

ChatPulse Group Logic 是一个 SillyTavern 第三方前端扩展。它在 ST 页面内提供一个独立群聊中心，用 ST 的角色卡、user persona、世界书和生成 API 组织 ChatPulse 风格群聊。默认使用 ST 当前 API，也允许按角色配置专属群聊 API。

当前文档对应版本：`0.4.0`。

## 设计边界

- 不创建 SillyTavern 原生群聊。
- 不依赖 ChatPulse 后端、数据库或向量记忆。
- 本仓库负责微信式群聊、群成员主动消息与群嫉妒；私聊主动消息、私聊嫉妒和每角色私聊定时由独立项目 [ST-AutoPulse](https://github.com/NANA3333333/ST-AutoPulse) 负责。两边的数据、计时器和 API 配置互不混用。
- 群聊列表、消息、红包和摘要保存在浏览器 localStorage；完整 Prompt、输出和错误诊断只保留在当前页面会话。
- 每个群聊可以绑定一个明确存在的 SillyTavern user persona。
- 每个群聊可以选择不同角色成员，因此可以同时维护多个独立群。

## 关键文件

- `manifest.json`：SillyTavern 扩展声明。
- `index.js`：群聊数据、UI、生成轮询、红包、记忆、世界书注入。
- `automation-core.js`：可独立测试的群成员主动调度、群嫉妒提示和角色 API 路由状态转换。
- `style.css`：群聊中心、创建弹窗、管理抽屉和移动端样式。
- `bootstrap.js`：轻量调试/启动辅助。
- `tests/`：`0.4.0` 自动化核心与生产入口接线测试。
- `server-plugin/chatpulse_group_logic_debug/index.js`：可选服务端调试插件。
- `README.md`：安装和基础使用。
- `USER_GUIDE.md`：面向初次使用者的完整操作、按钮和排错说明。
- `API.md`：接口、数据结构和 ST API 边界。

## 运行流程

1. 扩展加载后注入 ChatPulse 群聊入口；没有本地群聊的新用户会自动进入可恢复的新手引导。
2. 引导通过高亮和箭头要求用户真实点击入口、创建按钮和管理按钮。
3. 创建群聊时选择群名、user persona 和角色成员，未完成的建群内容保存为引导草稿。
4. 用户在群聊窗口发送消息。
5. 扩展把消息写入本群 localStorage，并根据 `@` 内容决定角色回复顺序。
6. 每个角色回复前，扩展构造包含角色卡、群历史、user persona、世界书和长期记忆的提示词。
7. 未配置角色专属群聊 API 时，扩展调用 SillyTavern `generateRaw`，只发送显式构造的 system/user 消息，生成该角色的一条群消息。
8. 若角色配置了完整的专属群聊 API，则同一份显式消息改由 SillyTavern `ChatCompletionService` 携带该角色的 `secret_id` 请求；配置不完整时显式报错。
9. 群主动调度按 `(groupId, memberAvatar)` 运行；命中群嫉妒时仍只生成同一条消息，不进入普通群轮询或接龙。
10. 输出经过清理、正则和红包标签解析后写回当前群。

## 多群聊与 user 绑定

群聊数据是数组结构：

```text
state.localGroups[]
```

每个群通过 `id` 区分，当前打开群通过 `state.activeGroupId` 指向。

每个群有自己的：

- `members`：角色成员
- `memberAutomation`：当前群内每个成员独立的主动消息、群嫉妒、倒计时与跨窗口 claim
- `userPersonaAvatar`：本群 user 人设
- `messages`：本群消息
- `redPackets`：本群红包
- `memory`：本群长期摘要
- `worldInfoBooks`：本群额外世界书

因此可以创建多个群，并让不同群使用不同 user persona 和不同角色组合。

角色专属群聊 API 不放在群对象里，而是按角色 avatar 存入 SillyTavern 扩展设置；这样同一角色在多个 ChatPulse 群中使用同一路由，而每个群的主动开关和时间仍彼此独立。明文 Key 由 SillyTavern Secrets 保存。

同一个群的 `members` 可以来自不同的 SillyTavern 角色卡。电脑端会常驻显示群列表；手机端从聊天页左上角返回全屏群列表。创建新群不会删除或覆盖旧群。

跨私聊或跨群共享记忆时，user persona 也是身份边界：只有源端和目标端都有明确且相同的 persona，并且对应权限已开启，记忆才会注入。缺少 persona 元数据时一律不共享。

## 世界书策略

世界书不是必填项。

- 群管理里的“群聊世界书”是额外指定的群级世界书。
- “同时读取成员角色卡世界书”开启时，会读取当前发言角色绑定的世界书。
- 如果没有选择任何群级世界书，角色仍然可以只依赖角色卡和群聊上下文生成。

## 调试策略

群管理抽屉里的“最近输入 / 输出”记录每次角色生成的：

- Prompt
- Raw Output
- Sanitized
- 是否重试
- 失败原因

这些内容只保存在当前页面会话，刷新后自动清除，不会随群聊正文写入 localStorage。

如果发送后完全没有反应，先确认：

- SillyTavern 普通私聊是否能生成。
- 当前群是否至少有一个角色成员。
- 队列面板是否显示正在等待 API 间隔或速率退避。
- 浏览器控制台或可选服务端调试插件是否有错误。
