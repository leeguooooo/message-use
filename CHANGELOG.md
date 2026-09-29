# Changelog

## 0.1.1

- `code --json` now exits 4 when no code is found (it still prints `null`, or `[]` with `--all`), including when `--wait` times out. Before, it exited 0 and scripts could not tell a timeout from a code.
- `code --wait` no longer quits with exit 3 when a poll collides with Messages.app writing the database (often the moment the awaited text arrives): reads wait out SQLite locks and a failed poll is retried.

## 0.1.0

First release. Read, search, watch and send iMessage / SMS through macOS Messages, and extract verification codes from incoming texts (`message-use code --wait`). Read-only database access, send previews unless `--yes`, contact names from Contacts, *-use family upgrade convention (`upgrade --check/--json`, daily notice), Developer ID signed and notarized binaries.
