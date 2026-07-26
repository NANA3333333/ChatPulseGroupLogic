# 微信拟真界面 Design QA

## 结论

`passed`

桌面端与移动端均完成“参考图 + 实际运行截图”的并排比对。最终轮没有遗留 P0、P1 或 P2 级视觉/交互问题。

## 视觉基准

### 桌面端

- 目标：当前 Windows 微信 4.1.8 风格的三栏结构。
- 参考截图：`../harness/wechat-fidelity/wechat-windows-4.1.8-reference.png`
- 参考来源：IT之家《微信 Windows 4.1.8 正式版更新》与 Microsoft Store 微信官方应用页。
- 参考画面：1440 × 1027；比对时归一化并裁切到 1240 × 820。
- 实现画面：浏览器视口 1363 × 936；群聊应用窗口 1240 × 820。
- 最终并排图：`../harness/wechat-fidelity/desktop-comparison-pass4.png`

### 移动端

- 目标：微信 Android 官方截图中的群聊标题栏、灰色消息区、白/绿气泡和底部输入栏。
- 参考截图：`../harness/wechat-fidelity/wechat-mobile-official-reference.png`
- 参考来源：Google Play 微信官方应用页。
- 参考画面：256 × 512；主体对话区按比例放大后与实现画面对齐。
- 实现画面：390 × 844 CSS viewport。
- 最终并排图：`../harness/wechat-fidelity/mobile-comparison-pass2.png`

## 实现范围

- `index.js`
  - 桌面端功能栏、群列表、搜索、创建群聊、消息区、群管理与输入栏。
  - 手机端群列表 → 群聊全屏切换、返回按钮和成员数标题。
  - 桌面端 13 步、手机端 12 步箭头式新手引导，包含实际创建第一个群聊。
- `style.css`
  - 桌面端微信式蓝色功能栏、灰色会话栏、绿色选中态、聊天区和输入区。
  - 移动端微信式单屏布局、标题栏、消息气泡和固定输入栏。
- `bootstrap.js`、`manifest.json`
  - 版本和缓存标识统一为 0.3.0。

## 状态与交互检查

| 检查项 | 结果 |
| --- | --- |
| 打开群聊中心 | 通过 |
| 两个群聊同时显示并可互相切换 | 通过 |
| 群聊搜索由 2 条过滤到 1 条 | 通过 |
| 新建群聊入口和表单 | 通过 |
| 群管理抽屉打开/关闭 | 通过 |
| 记忆与世界书设置区可查看 | 通过 |
| 桌面端发送区布局 | 通过 |
| 手机端列表进入聊天 | 通过 |
| 手机端聊天返回列表 | 通过 |
| 手机端 `··· → 使用帮助 / 选择删除` | 通过 |
| 新手引导指向 `＋` 创建按钮 | 通过 |
| 新手引导指向群名称输入框 | 通过 |

新手引导证据：

- `../../cpgl-wechat-onboarding-create-final.jpg`
- `../../cpgl-wechat-onboarding-name-final.jpg`

## 修复记录

1. 第一轮发现 SillyTavern 动态可访问性样式覆盖了选中群的绿色背景，导致选中行发白；已缩小 hover 选择器范围并修复。
2. 第一轮角色头像仍有问号占位；已替换为三个测试角色生成的清晰人物头像。
3. 第二轮桌面端功能栏、选中态和消息气泡颜色偏离参考；已按参考图调整为蓝色栏、`#07c160` 选中态和 `#95ec69` 发送气泡。
4. 移动端长占位文字出现折行并挤压输入区；已改为“发消息”。

## 最终可接受差异（P3）

- 使用 Font Awesome 中最接近的图标，笔画与微信专有图标不完全相同。
- 桌面端帮助、删除和群管理入口比微信原生标题栏稍密，用于保留扩展的可发现性和新手教学；手机端只保留微信式 `···`，帮助与选择删除收进“聊天信息”页。
- 移动端截图只覆盖扩展内容视口，不伪造手机系统状态栏。
- 桌面端是 SillyTavern 内的微信式独立窗口，不伪造操作系统窗口边框。

## 控制台与回归

- 应用来源的控制台 error：0。
- 云浏览器自身的 metadata 扩展出现过与应用无关的错误，已排除。
- `node --check index.js`：通过。
- `node --check bootstrap.js`：通过。
- 源码/隐私/可访问性/微信布局契约：47 / 47。
- `git diff --check`：通过。

## 最终证据

- 桌面端实际运行：`../../cpgl-wechat-desktop-airp-v5-final.jpg`
- 移动端实际运行：`../../cpgl-wechat-mobile-airp-v5-final.jpg`
- 移动端聊天信息与帮助/删除入口：`../../cpgl-wechat-mobile-chat-info-v5-final.jpg`
- AIRP 连续性测试图：`../evidence/cpgl-airp-continuity.png`
- 最终判定：`passed`
