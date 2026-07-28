# Design QA · ChatPulse Group Logic 0.4.0

## Target

- Desktop: Windows WeChat-style three-column hierarchy (utility rail, conversation list, active chat).
- Mobile: WeChat-style single-screen conversation with back navigation and `···` chat information.
- Advanced member settings: compact chat-info cards, clear scope badges, touch targets of at least 44 px on narrow/coarse-pointer layouts.

## Source evidence

- Existing v0.3.0 real SillyTavern captures in `docs/screenshots/`.
- Tencent Weixin / WeChat product reference: <https://www.tencent.com/zh-cn/products/weixin-wechat/>.

## Code checks completed

- Desktop and mobile structures remain separate responsive states.
- New member automation and role API controls use the existing WeChat-neutral white/gray surfaces.
- “本群 × 此角色” and “该角色在本扩展所有群共用” scopes are visible on the member card.
- Two-column number fields collapse to one column on small/coarse-pointer layouts.
- New mobile action controls retain a minimum height of 44 px.
- New onboarding steps point to group proactive settings and role API settings.

## Visual comparison status

The final 0.4.0 source was started in a SillyTavern 1.18.0 local preview. The cloud browser subsequently blocked the local preview URL under its security policy, so a same-viewport final screenshot comparison could not be completed. The repository therefore keeps the existing v0.3.0 real screenshots clearly labeled as historical evidence and does not present them as 0.4.0 captures.

## Final result

final result: blocked

Blocker: final 0.4.0 browser capture and same-viewport visual comparison were unavailable after the cloud browser’s local-URL security block. Functional source checks, automated tests, and live model tests are reported separately in `TEST_REPORT.md`.
