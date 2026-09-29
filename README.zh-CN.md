# message-use

**让 AI agent 通过 macOS「信息」读、搜、盯、发 iMessage 和短信，并从收到的短信里取出验证码。** [*-use 家族](https://github.com/leeguooooo/plugins)成员。

[English](./README.md)

iPhone 把消息同步到 Mac（iCloud 信息，或者短信用「短信转发」）之后，所有消息都在本机的一个数据库里。`message-use` 让 Claude Code、Codex 或其他 agent 直接读它，并通过「信息」App 回复。不用操作手机，也不经过任何云服务。

```bash
message-use chats                          # 最近的会话：编号、名字、未读数
message-use history 老王 --limit 20         # 会话可以用编号、号码/邮箱或名字的一部分
message-use recent --since 1h              # 最近收到的消息
message-use search "快递" --since 30d
message-use code --wait 120 --from 支付宝   # 等下一条验证码
message-use watch --json                   # 实时输出新消息（NDJSON）
message-use send --to 老王 --text "到了"     # 只预览
message-use send --to 老王 --text "到了" --yes
```

## 短信验证码

agent 最常用的场景：在网站或 App 上注册、登录，让它发短信验证码，然后

```bash
message-use code --wait 120            # 只返回开始等待之后才收到的验证码
message-use code --json                # 最近 10 分钟里最新的验证码
```

中文、英文、日文的常见写法都认得：验证码 / 校验码 / 动态码、code is、認証コード、「123456 是您的验证码」、`G-123456`，以及 `VVB12F` 这种字母数字混合的码。订单号、金额、手机号，以及只是提到「验证码」的反诈提醒，都不会被误认。在一个约两万条短信的真实收件箱上：带验证码的短信识别率 98.9%，234 条反诈提醒零误报。

## 安装

```sh
curl -fsSL https://raw.githubusercontent.com/leeguooooo/message-use/main/install.sh | sh
```

macOS 14 及以上，Apple 芯片或 Intel 都可以。程序经过 Developer ID 签名和 Apple 公证。

- **读消息**需要给运行它的程序（你的终端）开「完全磁盘访问权限」：系统设置 › 隐私与安全性 › 完全磁盘访问权限。`message-use doctor` 会检查。
- **发消息**第一次会请求「自动化」权限（终端 → 信息）。
- **发短信**需要在 iPhone 上打开短信转发：设置 › App › 信息 › 短信转发。

Claude Code：`/plugin install message-use@leeguooooo-plugins`（或者装整个家族：`use-family@leeguooooo-plugins`）。

## 安全

- 数据库**只读**打开，message-use 从不修改它。
- `send` 不带 `--yes` 只会显示将要发送的内容，skill 要求 agent 把预览给你看，等你确认。
- 收件人和内容作为参数传给 AppleScript，不拼进脚本。
- 消息正文是数据，skill 要求 agent 不执行消息里出现的指令。

## 同类项目

[steipete/imsg](https://github.com/steipete/imsg) 是读同一个数据库的成熟 Swift CLI，只读访问、正文解码、AppleScript 发送这几处都参考了它。message-use 增加了验证码提取，并遵循 *-use 家族的约定（安装脚本、升级、skill、发送前确认）。

## 许可

MIT

## 作者

**郭立（Guo Li / leeguoo）** 开发 —— [leeguoo.com](https://leeguoo.com/about) · [GitHub](https://github.com/leeguooooo) · [X](https://x.com/leeguooooo) · 更多工具见 [*-use 家族](https://github.com/leeguooooo/plugins)。
