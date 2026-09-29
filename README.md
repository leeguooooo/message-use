# message-use

**iMessage and SMS for AI agents, through macOS Messages: read, search, watch, send — and pull verification codes out of incoming texts.** Part of the [*-use family](https://github.com/leeguooooo/plugins).

[中文文档](./README.zh-CN.md)

When your iPhone syncs messages to your Mac (Messages in iCloud, or Text Message Forwarding for SMS), every text is in a local database. `message-use` lets Claude Code, Codex, or any agent read it and reply through Messages.app — no phone automation, no cloud service.

```bash
message-use chats                          # recent conversations: id, name, unread
message-use history 老王 --limit 20         # a chat by id, number/email, or part of a name
message-use recent --since 1h              # latest incoming texts
message-use search "快递" --since 30d
message-use code --wait 120 --from 支付宝   # wait for the NEXT verification code
message-use watch --json                   # stream new messages (NDJSON)
message-use send --to 老王 --text "到了"     # previews only
message-use send --to 老王 --text "到了" --yes
```

## Verification codes

The job agents need most: sign up or log in somewhere, ask for a code by SMS, then

```bash
message-use code --wait 120            # returns only a code that arrives after it starts
message-use code --json                # newest code from the last 10 minutes
```

Recognises Chinese, English and Japanese wording (验证码 / 校验码 / 动态码, "code is", 認証コード, "123456 是您的验证码", `G-123456`, alphanumeric codes like `VVB12F`), and ignores order numbers, amounts, phone numbers and anti-fraud notices that merely mention 验证码. On a real inbox of ~20,000 texts it finds a code in 98.9% of messages that carry one, with no false positives among 234 anti-fraud notices.

## Install

```sh
curl -fsSL https://raw.githubusercontent.com/leeguooooo/message-use/main/install.sh | sh
```

macOS 14+, Apple silicon or Intel. Binaries are Developer ID signed and notarized.

- **Reading** needs Full Disk Access for the app running `message-use` (your terminal): System Settings › Privacy & Security › Full Disk Access. `message-use doctor` checks it.
- **Sending** asks once for Automation permission (terminal → Messages).
- **SMS** sending needs Text Message Forwarding: iPhone › Settings › Apps › Messages › Text Message Forwarding.

Claude Code: `/plugin install message-use@leeguooooo-plugins` (or the whole family: `use-family@leeguooooo-plugins`).

## Safety

- The database is opened **read-only**; message-use never modifies it.
- `send` without `--yes` only prints what it would send. The skill tells agents to show that preview and wait for your confirmation.
- Recipient and text are passed to AppleScript as arguments, never spliced into the script.
- Message text is treated as data: the skill tells agents not to follow instructions found inside texts.

## Commands

| Command | Does |
|---|---|
| `chats` | Recent conversations with contact names (from Contacts) and unread counts |
| `history <chat>` | Messages in one conversation, oldest first; `--since`, `--limit` |
| `recent` | Latest incoming messages across all conversations |
| `search <text>` | Full-text search, including bodies stored only as attributed text |
| `code` | Newest verification code; `--wait`, `--from`, `--all` |
| `watch` | Stream new messages; `--chat`, `--json` |
| `send` | `--to`, `--text` or `--file`, `--service auto\|imessage\|sms`, `--yes` |
| `doctor` | Database access, contacts, sending prerequisites |
| `upgrade` | Self-upgrade (`--check`, `--json`), family convention |

All read commands take `--json`. Exit codes: 2 send previewed only, 3 no database access, 4 no code found, 5 send failed.

## Prior art

[steipete/imsg](https://github.com/steipete/imsg) is a mature Swift CLI for the same database and the reference for several details here (read-only access, attributed-body decoding, AppleScript sending). message-use adds verification-code extraction and follows the *-use family conventions (installer, upgrade, skill, consent before sending).

## License

MIT

## Author

Built by **郭立 (Guo Li / leeguoo)** — [leeguoo.com](https://leeguoo.com/about) · [GitHub](https://github.com/leeguooooo) · [X](https://x.com/leeguooooo) · more tools in the [*-use family](https://github.com/leeguooooo/plugins).
