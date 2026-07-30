# ChatPulse Group Logic 0.4.0

一个用于 SillyTavern 的第三方扩展，提供独立于 SillyTavern 原生群聊的微信式群聊入口与窗口，并保留 ChatPulse 群聊轮询逻辑。

这个扩展适合想要在 SillyTavern 里使用更接近即时通讯群聊体验的用户：它会复用 SillyTavern 的角色卡、世界书、用户人设和生成 API，但群聊列表、群聊窗口、消息记录和群聊控制都由扩展自己管理。

> 项目边界：本仓库负责**微信式群聊**。角色私聊的主动消息、私聊嫉妒与每角色私聊计时属于独立项目 [ST-AutoPulse](https://github.com/NANA3333333/ST-AutoPulse)。两个扩展可以同时安装，但数据、计时器和 API 设置互不混用。

## 实机截图与测试数据

### 0.4.0 当前源码：SillyTavern 实机功能图册

2026-07-30 把本仓库当前 `0.4.0` 与 `ST-AutoPulse 2.3.0` 同时安装到 SillyTavern `1.18.0`，用全新临时用户数据实际点击完成建群、电脑端/手机端群聊、成员主动消息、群嫉妒、角色群聊 API、长期记忆、帮助、`@`、红包、队列、调试和第二个群。下面不是设计稿或单独打开的 HTML。

这一轮功能图册刻意阻止模型请求，也没有输入或保存 API Key；它证明当前源码的页面、状态隔离和操作入口。真实模型对话与人设数据放在下一节，无法只靠静态图片证明的路由、无接龙和多窗口行为则由脱敏报告与自动化用例证明。

| 两个扩展同时安装 | 创建双角色群 |
|---|---|
| ![SillyTavern 扩展设置同时显示 ST-AutoPulse 和 ChatPulse Group Logic](docs/screenshots/v040-ui-00-both-extensions-loaded.png) | ![在当前源码中填写群名、选择 User 人设和两名成员](docs/screenshots/v040-ui-01-create-two-role-group.png) |

| 电脑端微信式三栏页面 | 本群 × 此角色的主动消息与 100% 群嫉妒 |
|---|---|
| ![当前 0.4.0 电脑端微信式群聊页面](docs/screenshots/v040-ui-02-two-role-group-chat.png) | ![成员设置中独立间隔、提示词、群嫉妒概率和立即测试按钮](docs/screenshots/v040-ui-03-member-proactive-jealousy.png) |

成员主动设置属于“本群 × 此角色”；角色群聊 API 属于“该角色在本扩展所有群共用”；总结模型又是第三套独立设置。

| 角色专属群聊 API（Key 未输入） | 长期摘要、总结模型与三项记忆权限 |
|---|---|
| ![角色群聊 API 的默认与专用模式、Endpoint、Model、温度和输出上限](docs/screenshots/v040-ui-04-role-specific-group-api.png) | ![长期记忆 R 窗口、S 阈值、总结模型与私聊群聊记忆权限](docs/screenshots/v040-ui-05-group-memory-settings.png) |

手机端不是把电脑窗口缩小，而是全屏聊天与“聊天信息”页面：

| 手机端群聊 `390×844` | 手机端成员主动设置 |
|---|---|
| ![手机端微信式全屏群聊、返回、群名和更多按钮](docs/screenshots/v040-ui-06-mobile-two-role-group-chat.png) | ![手机端聊天信息、帮助入口和成员主动设置](docs/screenshots/v040-ui-07-mobile-member-and-memory-settings.png) |

帮助中心会直接解释第一次建群、按钮图鉴、回复规则、成员主动消息和角色 API；右下角可以重新启动箭头引导。

![0.4.0 当前帮助中心和按钮图鉴](docs/screenshots/v040-ui-08-help-center-and-button-guide.png)

| `@` 全体/角色选择 | 红包发送窗口 |
|---|---|
| ![输入 @ 后出现全体成员和两名角色](docs/screenshots/v040-ui-09-at-mention-menu.png) | ![拼手气和普通红包窗口，包含人数、金额和留言](docs/screenshots/v040-ui-10-red-packet-modal.png) |

实机截图时发现红包标题被后置 CSS 覆盖成白底白字；当前源码已修复为上图的红底白字，并加入视觉回归测试。

| 运行队列、最近输入/输出与红包记录 | 调试清理、按条删除和危险操作 |
|---|---|
| ![群管理中的运行队列、调试记录和红包记录](docs/screenshots/v040-ui-11-running-queue-panel.png) | ![清空队列、删除对话记录和删除当前群聊](docs/screenshots/v040-ui-12-debug-and-danger-controls.png) |

同一角色进入第二个群时，第二群默认仍是“主动：未开启”，不会继承第一个群的开关和间隔；左侧两个群都会保留。

![第二个群保留独立成员和自动化状态](docs/screenshots/v040-ui-13-two-groups-independent-settings.png)

- [0.4.0 当前实机 UI 机器记录](docs/test-data/v040-sillytavern-ui-capture.json)：14 张截图、桌面/手机视口、两个扩展同装、零模型请求与零 Secret。
- 当前确定性检查为 **20 / 20**：在原有 19 项之外增加了红包标题可见性的回归契约。

### 0.4.0 当前界面：角色 API、双角色对话与群主动联动

下面一组继续使用本仓库当前 `0.4.0` 源码，在 SillyTavern `1.18.0` 中实际点击设置和发送按钮。由于本轮测试环境连接 DeepSeek 时长时间无返回，浏览器请求由本地 OpenAI-compatible 测试端点接住，并回放下一节已经保存的真实 DeepSeek 输出。机器报告明确记录 `fixtureReplay: true`、`providerCallThisRun: false`；因此这些图片证明的是**当前界面的路由参数、消息落盘和无接龙行为**，不是一次新的外部模型调用。

| 沈砚秋：使用角色专属群聊 API | 弥拉·周：跟随 SillyTavern 当前 API |
|---|---|
| ![沈砚秋选择角色专属群聊 API，显示 Endpoint、Model 与空白 Key 输入框](docs/screenshots/v040-replay-01-role-api-custom-route.png) | ![弥拉周的角色群聊 API 保持跟随 SillyTavern 当前连接](docs/screenshots/v040-replay-01b-role-api-follows-st.png) |

截图中的 Key 输入框为空，仓库和报告都没有保存明文 Key。脱敏请求记录显示：沈砚秋请求携带 `custom_url + secret_id`，弥拉·周请求不携带这两个专属字段。

![当前 0.4.0 界面中的用户消息与两名角色实际群聊回放](docs/screenshots/v040-replay-02-two-role-group-round.png)

普通群聊从 0 条变为 3 条：1 条用户消息、1 条沈砚秋回复和 1 条弥拉·周回复。两段回复分别保留旧书店主的纸张/墨迹细节和机械师的电路/风险口吻。

| 本群主动消息与 100% 群嫉妒设置 | 两次明确测试后的群消息 |
|---|---|
| ![为群成员设置主动消息、独立间隔与百分百群嫉妒](docs/screenshots/v040-replay-03-member-automation-jealousy-settings.png) | ![先测试弥拉普通主动消息，再测试沈砚秋群嫉妒主动消息](docs/screenshots/v040-replay-04-proactive-jealousy-no-chain.png) |

右图包含两次用户明确点击的“立即测试一条”：先生成弥拉·周的普通主动消息，再生成沈砚秋的“主动消息 + 100% 群嫉妒”消息，并不是一次触发后角色自动互相接龙。对沈砚秋这次联动，消息数为 `4 → 5 → 5`：立即只增加 1 条，等待 5.5 秒后仍为 5 条。群嫉妒只改变同一条主动消息的提示与语气，没有额外弹窗、第二条嫉妒消息、`@` 或红包连锁。

- [当前 UI 路由与无接龙脱敏报告](docs/test-data/v040-current-ui-fixture-replay-e2e.json)：5 / 5 个当前界面请求成功，专属/默认路由字段符合预期，结果为 `PASS_PARTIAL`。
- `PASS_PARTIAL` 表示这里只重跑了角色路由、双角色普通轮询和主动消息联动；总结模型与跨私聊/跨群记忆没有在这一轮浏览器回放里重新调用，相关模型结果仍以 16 次真实 DeepSeek 数据和确定性用例为准。

### 0.4.0 DeepSeek V4 Flash 真实 AIRP 数据

当前版本使用用户授权的 DeepSeek 官方 API，按 AIRP 用户方式跑了 16 次 `deepseek-v4-flash` 角色扮演请求：

- 两名角色连续接话、意见冲突与协商；
- 两名角色各自的群主动消息；
- 两名角色各自的“群主动消息 + 嫉妒”单条联动；
- 同群记忆、跨群隔离、私聊记忆未注入 / 明确注入；
- 角色口吻、单角色输出和主动消息禁止接龙。

结果为 `16 / 16` 次请求成功、`72 / 72` 项断言通过，共使用 10,073 tokens。API Key 只在测试进程内存中使用，未写入仓库或测试数据。

> 沈砚秋：指尖抚过报头边缘，纸张触感泛涩，像是民国年间的道林纸。字迹确实藏在叠层间，墨色边缘有轻微渗化——不是印刷，是手写。

> 弥拉·周：右墙抹灰脱落风险约25%，书架承重尚可。我去取，如果摸到墙皮发潮或框架松动就停，回来先加固。

- [完整测试摘要](docs/test-data/v040-deepseek-v4-flash-live-roleplay.md)
- [16 次请求、输出、延迟、Token 与断言 JSON](docs/test-data/v040-deepseek-v4-flash-live-roleplay.json)

当前截图环境无法再次连出到模型服务时，只会把这批已保存且脱敏的真实输出回放到当前 UI，并在报告中标明 `providerCallThisRun: false`；不会把回放冒充成新 API 调用。`0.4.0` 自动化检查为 `20 / 20`，真实模型组合检查为 `72 / 72`；测试范围和截图边界见 [测试报告](TEST_REPORT.md)。

<details>
<summary>展开 0.3.0 历史实机基线</summary>

以下截图和 AIRP 数据来自 2026-07-26 的 `0.3.0` 实机测试，用于保留原有微信式界面、建群引导和记忆链路的历史证据，不证明 `0.4.0` 新功能。

| 历史电脑端 | 历史手机端 |
|---|---|
| ![0.3.0 电脑端 AIRP 群聊](docs/screenshots/wechat-desktop-airp.jpg) | ![0.3.0 手机端 AIRP 群聊](docs/screenshots/wechat-mobile-airp.jpg) |

| 历史手机聊天信息 | 历史 AIRP 连续性 |
|---|---|
| ![0.3.0 手机聊天信息](docs/screenshots/wechat-mobile-chat-info.jpg) | ![0.3.0 AIRP 跨窗口记忆测试数据](docs/screenshots/airp-continuity.png) |

| 历史引导：新建群聊 | 历史引导：群名输入 |
|---|---|
| ![0.3.0 箭头指向新建群聊](docs/screenshots/onboarding-create.jpg) | ![0.3.0 箭头指向群名称输入](docs/screenshots/onboarding-name.jpg) |

</details>

## 功能

- 首次使用自动启动游戏式新手引导，用高亮和箭头带用户实际创建第一个群聊
- 内置帮助中心（电脑端 `?`；手机端 `··· → 使用帮助`），可随时查看按钮图鉴、回复规则、记忆权限和排错说明
- 新手引导支持暂停、继续、跳过、重新开始，并保存未完成的建群草稿
- 电脑端采用 Windows 微信式三栏布局，手机端采用微信式群列表与全屏对话切换
- 独立群聊入口和群聊窗口，已有多个群时会全部保留在会话列表中
- 创建群聊、拉人入群、踢人出群、删除群聊
- 同一群可混合不同 SillyTavern 角色卡，并可同时保留多个独立群
- 每个群、每个成员可分别开启主动发言，并设置独立的最短/最长间隔与提示词
- 群嫉妒与该角色本次主动发言合并为一条消息，不额外生成第二条，也不触发 `@`、红包或成员接龙
- 同一角色可配置专属群聊 Endpoint / Model / API Key；该配置跨本扩展的所有群共用，没有配置或选择“跟随 SillyTavern 当前 API（默认）”时继续使用 SillyTavern 当前 API
- 明确选择角色自定义 API 后，Endpoint、Model 或 Key 任一不完整都会直接报错，不会静默回退到其他连接
- 角色群聊 API Key 写入 SillyTavern Secrets，扩展设置只保存 `secret_id`，不会把明文 Key 写入 localStorage
- 支持 Web Locks 的同源多标签页会在互斥锁内 claim；不支持时使用 localStorage lease 兼容回退。长时间离线后不会补发一串历史消息
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

默认情况下，所有角色直接使用 SillyTavern 当前连接的模型/API。只有当你在“群管理 → 群成员 → 角色群聊 API”中选择“此角色使用专用 API”时，该角色才改用自己的 OpenAI-compatible Endpoint、Model 与保存在 SillyTavern Secrets 中的 Key。没有角色配置或选择“跟随 SillyTavern 当前 API（默认）”时会使用 SillyTavern 当前连接；已经明确选择专用模式但配置不完整时会直接报错，不会静默回退。长期记忆的“总结小模型”是另一套独立设置，不会被角色群聊 API 覆盖。世界书仍是可选项。

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
- **成员主动消息**：只让已开启的那个成员在对应群里发送一条消息；不会启动普通群轮询。
- **群嫉妒**：只作为该成员主动消息的语气/动机联动，不另发嫉妒通知，不与私聊嫉妒共享设置。

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
- 群主动设置按“群 ID × 角色 avatar”保存在群数据中；同一角色在两个群里可使用不同开关与间隔。
- 角色专属群聊 API 的非敏感字段保存在 SillyTavern 扩展设置中；明文 Key 只进入 SillyTavern Secrets。
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

自动化检查：

```bash
npm run check
```

当前 `0.4.0` 自动化检查包含 20 个用例，覆盖群 × 角色定时隔离、群嫉妒单提示与禁止接龙、跨窗口 claim 状态转换、角色群聊 API 默认/自定义路由、生产入口接线及红包标题视觉回归。真实模型质量另有 16 次 DeepSeek V4 Flash 请求和 72 项组合断言；当前浏览器实机图、真实模型数据和历史截图仍按上文明确区分验证范围。

## 许可证

Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International，简称 CC BY-NC-ND 4.0。

完整协议见 `LICENSE`，或访问：

```text
https://creativecommons.org/licenses/by-nc-nd/4.0/
```
