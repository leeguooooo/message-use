#!/usr/bin/env bun
// message-use — read, search, watch and send iMessage / SMS through macOS Messages,
// and pull verification codes out of incoming texts. Part of the *-use family.

import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { extractCode, smsBrand } from "./codes.ts";
import {
  ChatDbError,
  chatDbPath,
  chatHistory,
  contactName,
  listChats,
  loadContacts,
  maxMessageId,
  openChatDb,
  recentMessages,
  resolveChat,
  searchMessages,
  type Chat,
  type ContactBook,
  type Message,
} from "./db.ts";
import { sendFileToHandle, sendToChat, sendToHandle } from "./send.ts";
import {
  checkUpgrade,
  detectSkillChannels,
  maybeUpdateNotice,
  MESSAGE_USE_UPGRADE_INSTALLER_ENV,
  refreshSkills,
  runInstaller,
  runUpdateCheck,
  INSTALL_SCRIPT_URL,
  UPDATE_CHECK_COMMAND,
} from "./upgrade.ts";
import { SKILL_MD } from "./skill.ts";

export const VERSION = "0.1.0";

const HELP = `message-use ${VERSION} — iMessage / SMS for agents, through macOS Messages.

Usage:
  message-use chats [--limit N] [--json]
      Recent conversations with contact names and unread counts.
  message-use history <chat> [--limit N] [--since 2h] [--json]
      Messages in one conversation. <chat> is an id from \`chats\`, a phone number / email,
      or part of a contact or group name.
  message-use recent [--since 1h] [--limit N] [--json]
      Latest incoming messages across all conversations.
  message-use search <text> [--since 30d] [--limit N] [--json]
      Full-text search, including bodies newer macOS stores only as attributed text.
  message-use code [--since 10m] [--from <name|number|brand>] [--wait SECONDS] [--json]
      Newest verification code from incoming texts. --wait polls until a new one arrives
      (use it right after triggering "send me a code").
  message-use watch [--chat <chat>] [--json]
      Stream new messages as they arrive (Ctrl+C to stop).
  message-use send --to <chat|number|email> (--text <text> | --file <path>) [--service auto|imessage|sms] [--yes]
      Without --yes, prints what would be sent and sends nothing. Pass --yes only after the
      user has confirmed the recipient and the text.
  message-use doctor            Check database access, contacts, and sending prerequisites.
  message-use skill install     Install the agent skill for Claude Code, Codex and ~/.agents.
  message-use upgrade [--check | --json]
  message-use version | help

Reading needs Full Disk Access for the app that runs message-use (your terminal).
SMS sending needs Text Message Forwarding enabled for this Mac on the iPhone.
Opt out of the daily update notice: MESSAGE_USE_NO_UPDATE_CHECK=1.`;

// ───────────────────────── args ─────────────────────────

interface Parsed {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set(["limit", "since", "from", "wait", "chat", "to", "text", "file", "service", "interval-ms"]);
const BOOL_FLAGS = new Set(["json", "yes", "check", "all"]);

function parseArgs(argv: string[]): Parsed {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith("--")) {
      const [key, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
      if (VALUE_FLAGS.has(key)) {
        const value = inline ?? argv[++i];
        if (value === undefined) fail(`--${key} needs a value`);
        flags.set(key, value);
      } else if (BOOL_FLAGS.has(key)) {
        flags.set(key, true);
      } else {
        fail(`unknown flag --${key}`);
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function fail(message: string, code = 1): never {
  process.stderr.write(`message-use: ${message}\n`);
  process.exit(code);
}

function flagString(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}

function flagInt(p: Parsed, name: string, fallback: number): number {
  const raw = flagString(p, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) fail(`--${name} must be a positive integer`);
  return n;
}

/** "30s" / "10m" / "2h" / "7d" → milliseconds. */
export function parseDuration(raw: string): number | null {
  const m = /^(\d+)\s*(s|m|h|d)?$/i.exec(raw.trim());
  if (m === null) return null;
  const n = Number(m[1]);
  const unit = (m[2] ?? "m").toLowerCase();
  return n * (unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000);
}

function sinceMs(p: Parsed, fallback?: string): number | undefined {
  const raw = flagString(p, "since") ?? fallback;
  if (raw === undefined) return undefined;
  const ms = parseDuration(raw);
  if (ms === null) fail(`--since takes a duration like 30s, 10m, 2h, 7d (got ${raw})`);
  return Date.now() - ms;
}

// ───────────────────────── output ─────────────────────────

function localTime(iso: string | null): string {
  if (iso === null) return "?";
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function printMessage(m: Message): void {
  const who = m.from_me ? "me" : m.sender ?? "?";
  const body = m.text ?? (m.attachments > 0 ? `[${m.attachments} attachment${m.attachments > 1 ? "s" : ""}]` : "[no text]");
  console.log(`${localTime(m.date)}  ${who}: ${body.replace(/\n/g, "\n    ")}`);
}

function printJson(value: unknown): void {
  console.log(JSON.stringify(value, null, 2));
}

function withDb<T>(fn: (db: ReturnType<typeof openChatDb>, book: ContactBook) => T): T {
  let db: ReturnType<typeof openChatDb>;
  try {
    db = openChatDb();
  } catch (error) {
    if (error instanceof ChatDbError && error.code === "no-access") {
      fail(`${error.message}\nGrant Full Disk Access to your terminal: System Settings › Privacy & Security › Full Disk Access, then restart the terminal. (\`message-use doctor\` checks it.)`, 3);
    }
    fail(error instanceof Error ? error.message : String(error), 3);
  }
  try {
    return fn(db, loadContacts());
  } finally {
    db.close();
  }
}

function pickChat(chats: Chat[], ref: string): Chat {
  if (chats.length === 0) fail(`no conversation matches ${ref} (see \`message-use chats\`)`);
  if (chats.length > 1) {
    const list = chats.slice(0, 8).map((c) => `  ${c.id}  ${c.name ?? c.identifier}`).join("\n");
    fail(`${ref} matches ${chats.length} conversations — pass an id:\n${list}`);
  }
  return chats[0]!;
}

// ───────────────────────── commands ─────────────────────────

function cmdChats(p: Parsed): void {
  withDb((db, book) => {
    const chats = listChats(db, book, flagInt(p, "limit", 20));
    if (p.flags.has("json")) return printJson(chats);
    for (const c of chats) {
      const unread = c.unread > 0 ? `  (${c.unread} unread)` : "";
      console.log(`${String(c.id).padStart(5)}  ${localTime(c.last_message_at)}  ${c.name ?? c.identifier}${c.group ? " [group]" : ""}  ${c.service ?? ""}${unread}`);
    }
  });
}

function cmdHistory(p: Parsed): void {
  const ref = p.positional[0] ?? flagString(p, "chat");
  if (ref === undefined) fail("usage: message-use history <chat> [--limit N] [--since 2h] [--json]");
  withDb((db, book) => {
    const chat = pickChat(resolveChat(db, book, ref), ref);
    const messages = chatHistory(db, book, chat.id, { limit: flagInt(p, "limit", 30), sinceMs: sinceMs(p) });
    if (p.flags.has("json")) return printJson({ chat, messages });
    console.log(`# ${chat.name ?? chat.identifier} (id ${chat.id}${chat.group ? ", group" : ""})`);
    for (const m of messages) printMessage(m);
  });
}

function cmdRecent(p: Parsed): void {
  withDb((db, book) => {
    const messages = recentMessages(db, book, { sinceMs: sinceMs(p, "1d"), limit: flagInt(p, "limit", 20), incomingOnly: true });
    if (p.flags.has("json")) return printJson(messages);
    for (const m of messages.slice().reverse()) printMessage(m);
  });
}

function cmdSearch(p: Parsed): void {
  const query = p.positional.join(" ");
  if (query === "") fail("usage: message-use search <text> [--since 30d] [--limit N] [--json]");
  withDb((db, book) => {
    const found = searchMessages(db, book, query, { limit: flagInt(p, "limit", 20), sinceMs: sinceMs(p) });
    if (p.flags.has("json")) return printJson(found);
    if (found.length === 0) console.log(`no messages match "${query}"`);
    for (const m of found) printMessage(m);
  });
}

export interface CodeHit {
  code: string;
  brand: string | null;
  sender: string | null;
  handle: string | null;
  date: string | null;
  age_seconds: number | null;
  message_id: number;
  text: string;
}

export function findCodes(messages: Message[], from?: string): CodeHit[] {
  const needle = from?.toLowerCase();
  const hits: CodeHit[] = [];
  for (const m of messages) {
    if (m.from_me || m.text === null) continue;
    const code = extractCode(m.text);
    if (code === null) continue;
    const brand = smsBrand(m.text);
    if (needle !== undefined) {
      const hay = [m.sender, m.handle, brand, m.text].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(needle)) continue;
    }
    hits.push({
      code,
      brand,
      sender: m.sender,
      handle: m.handle,
      date: m.date,
      age_seconds: m.date === null ? null : Math.round((Date.now() - Date.parse(m.date)) / 1000),
      message_id: m.id,
      text: m.text,
    });
  }
  return hits;
}

async function cmdCode(p: Parsed): Promise<void> {
  const from = flagString(p, "from");
  const waitRaw = flagString(p, "wait");
  const waitMs = waitRaw === undefined ? 0 : parseDuration(/^\d+$/.test(waitRaw) ? `${waitRaw}s` : waitRaw);
  if (waitMs === null) fail("--wait takes seconds (120) or a duration (2m)");
  const all = p.flags.has("all");
  const report = (hits: CodeHit[]) => {
    const shown = all ? hits : hits.slice(0, 1);
    if (p.flags.has("json")) return printJson(all ? shown : shown[0] ?? null);
    for (const h of shown) {
      console.log(`${h.code}  ${h.brand ?? h.sender ?? h.handle ?? "?"}  ${localTime(h.date)} (${h.age_seconds ?? "?"}s ago)`);
    }
  };
  if (waitMs === 0) {
    const hits = withDb((db, book) =>
      findCodes(recentMessages(db, book, { sinceMs: sinceMs(p, "10m"), limit: 200, incomingOnly: true }), from));
    if (hits.length === 0) {
      if (p.flags.has("json")) return printJson(all ? [] : null);
      fail(`no verification code in the last ${flagString(p, "since") ?? "10m"}${from ? ` from ${from}` : ""}`, 4);
    }
    return report(hits);
  }
  // --wait: only codes that arrive after now (a code already on screen is usually the stale one).
  const startId = withDb((db) => maxMessageId(db));
  const deadline = Date.now() + waitMs;
  process.stderr.write(`waiting up to ${Math.round(waitMs / 1000)}s for a new verification code${from ? ` from ${from}` : ""}…\n`);
  while (Date.now() < deadline) {
    const hits = withDb((db, book) => findCodes(recentMessages(db, book, { afterId: startId, limit: 50, incomingOnly: true }), from));
    if (hits.length > 0) return report(hits);
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  if (p.flags.has("json")) return printJson(all ? [] : null);
  fail(`no new verification code within ${Math.round(waitMs / 1000)}s`, 4);
}

async function cmdWatch(p: Parsed): Promise<void> {
  const ref = flagString(p, "chat");
  const interval = flagInt(p, "interval-ms", 1000);
  let chatId: number | undefined;
  let last = withDb((db, book) => {
    if (ref !== undefined) chatId = pickChat(resolveChat(db, book, ref), ref).id;
    return maxMessageId(db);
  });
  if (!p.flags.has("json")) process.stderr.write(`watching for new messages${ref ? ` in ${ref}` : ""} (Ctrl+C to stop)…\n`);
  for (;;) {
    await new Promise((resolve) => setTimeout(resolve, interval));
    const fresh = withDb((db, book) => recentMessages(db, book, { afterId: last, limit: 200 }));
    for (const m of fresh.slice().reverse()) {
      last = Math.max(last, m.id);
      if (chatId !== undefined && m.chat_id !== chatId) continue;
      if (p.flags.has("json")) console.log(JSON.stringify({ ...m, code: m.from_me ? null : extractCode(m.text) }));
      else printMessage(m);
    }
  }
}

function cmdSend(p: Parsed): void {
  const to = flagString(p, "to");
  const text = flagString(p, "text");
  const file = flagString(p, "file");
  if (to === undefined || (text === undefined) === (file === undefined)) {
    fail("usage: message-use send --to <chat|number|email> (--text <text> | --file <path>) [--service auto|imessage|sms] [--yes]");
  }
  if (file !== undefined && !existsSync(file)) fail(`no such file: ${file}`);
  const serviceFlag = (flagString(p, "service") ?? "auto").toLowerCase();
  if (!["auto", "imessage", "sms"].includes(serviceFlag)) fail("--service is auto, imessage or sms");

  const plan = withDb((db, book) => {
    const chats = resolveChat(db, book, to);
    const looksLikeHandle = /^\+?[\d\s()-]{5,}$/.test(to) || to.includes("@");
    if (chats.length === 1 && chats[0]!.group) {
      return { kind: "chat" as const, chat: chats[0]!, label: chats[0]!.name ?? chats[0]!.identifier, service: chats[0]!.service ?? "iMessage" };
    }
    if (chats.length > 1 && !looksLikeHandle) pickChat(chats, to);
    const chat = chats.length === 1 ? chats[0]! : undefined;
    const handle = chat?.handles[0] ?? (looksLikeHandle ? to.replace(/[\s()-]/g, "") : undefined);
    if (handle === undefined) fail(`no conversation or contact matches ${to}; pass a phone number or email`);
    let service: "iMessage" | "SMS";
    if (serviceFlag === "imessage") service = "iMessage";
    else if (serviceFlag === "sms") service = "SMS";
    else if (handle.includes("@")) service = "iMessage";
    else if (chat?.service === "iMessage" || chat?.service === "SMS") service = chat.service;
    else {
      // Unknown number: iMessage only if Messages has seen this handle on iMessage before;
      // most numbers (and every number outside Apple's world) only take SMS.
      const services = (db.query("select distinct service from handle where id = ? or id = ?")
        .all(handle, handle.startsWith("+") ? handle : `+${handle}`) as Array<{ service: string }>).map((r) => r.service);
      service = services.includes("iMessage") ? "iMessage" : "SMS";
    }
    const name = contactName(handle, book);
    return { kind: "handle" as const, handle, label: name ? `${name} (${handle})` : handle, service };
  });

  const what = file !== undefined ? `file ${file}` : JSON.stringify(text);
  if (!p.flags.has("yes")) {
    console.log(`would send to ${plan.label} via ${plan.service}: ${what}`);
    console.log("nothing sent — re-run with --yes once the user has confirmed recipient and text.");
    process.exitCode = 2;
    return;
  }
  let result;
  if (plan.kind === "chat") {
    if (file !== undefined) fail("sending files to group chats is not supported yet");
    result = sendToChat(plan.chat.guid, text!);
  } else if (file !== undefined) {
    result = sendFileToHandle(plan.handle, file, plan.service as "iMessage" | "SMS");
  } else {
    result = sendToHandle(plan.handle, text!, plan.service as "iMessage" | "SMS");
  }
  if (!result.ok) fail(`send failed: ${result.error}`, 5);
  console.log(`sent to ${plan.label} via ${plan.service}`);
}

function cmdDoctor(): void {
  const ok = (s: string) => console.log(`  ✅ ${s}`);
  const warn = (s: string) => console.log(`  ⚠️  ${s}`);
  console.log("Messages database");
  try {
    const db = openChatDb();
    const count = (db.query("select count(*) n from message").get() as { n: number }).n;
    const latest = recentMessages(db, new Map(), { limit: 1 })[0];
    db.close();
    ok(`${chatDbPath()} readable — ${count} messages, newest ${latest?.date ? localTime(latest.date) : "?"}`);
  } catch (error) {
    if (error instanceof ChatDbError && error.code === "no-access") {
      warn("no access — grant Full Disk Access to your terminal (System Settings › Privacy & Security › Full Disk Access), then restart it");
    } else {
      warn(error instanceof Error ? error.message : String(error));
    }
  }
  console.log("Contacts");
  const book = loadContacts();
  if (book.size > 0) ok(`${book.size} phone numbers / emails resolve to names`);
  else warn("no contacts readable — conversations show raw numbers (Full Disk Access also covers Contacts)");
  console.log("Sending");
  console.log("  ｰ  the first send asks for Automation permission (terminal → Messages); allow it");
  console.log("  ｰ  SMS: iPhone › Settings › Apps › Messages › Text Message Forwarding › enable this Mac");
}

function installSkill(): void {
  const home = homedir();
  for (const dir of [join(home, ".claude", "skills", "message-use"), join(home, ".codex", "skills", "message-use")]) {
    const path = join(dir, "SKILL.md");
    mkdirSync(dirname(path), { recursive: true });
    try {
      if (readFileSync(path, "utf8") === SKILL_MD) {
        console.log(`skill up to date: ${path}`);
        continue;
      }
    } catch {
      // missing: write it
    }
    const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      writeFileSync(tmp, SKILL_MD, { flag: "wx", mode: 0o644 });
      renameSync(tmp, path);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        // renamed
      }
    }
    console.log(`skill installed: ${path}`);
  }
}

async function cmdUpgrade(p: Parsed): Promise<void> {
  const check = await checkUpgrade(VERSION);
  if (p.flags.has("json")) {
    printJson({
      name: "message-use",
      current: VERSION,
      latest: check.status === "unknown" ? null : check.latest.replace(/^v/, ""),
      update_available: check.status === "behind",
      skills: detectSkillChannels(),
      ...(check.status === "unknown" ? { error: check.error } : {}),
    });
    if (check.status === "unknown") process.exitCode = 2;
    return;
  }
  if (check.status === "unknown") fail(`could not determine the latest release: ${check.error}`, 2);
  if (p.flags.has("check")) {
    console.log(check.status === "behind"
      ? `message-use ${VERSION} -> ${check.latest.replace(/^v/, "")}`
      : `message-use ${VERSION} is up to date`);
    return;
  }
  if (check.status !== "behind") {
    console.log(`message-use ${VERSION} is up to date`);
    return;
  }
  const local = process.env[MESSAGE_USE_UPGRADE_INSTALLER_ENV];
  console.log(`message-use ${VERSION} -> ${check.latest}; running ${local ? `sh ${local}` : `curl -fsSL ${INSTALL_SCRIPT_URL} | sh`}`);
  const run = runInstaller();
  if (run.code !== 0) fail(`installer failed (exit ${run.code ?? "spawn-failed"}); the installed binary is unchanged`, run.code ?? 1);
  for (const line of refreshSkills(detectSkillChannels())) console.log(line);
  console.log("upgrade complete");
}

function selfCommand(): string[] {
  const script = process.argv[1];
  const runtime = process.execPath.split(/[\\/]/).pop()!.toLowerCase();
  return (runtime === "bun" || runtime === "bun.exe") && typeof script === "string" && existsSync(script)
    ? [process.execPath, script]
    : [process.execPath];
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  const p = parseArgs(rest);
  maybeUpdateNotice(VERSION, command, selfCommand());
  switch (command) {
    case "chats": return cmdChats(p);
    case "history": return cmdHistory(p);
    case "recent": return cmdRecent(p);
    case "search": return cmdSearch(p);
    case "code": return cmdCode(p);
    case "watch": return cmdWatch(p);
    case "send": return cmdSend(p);
    case "doctor": return cmdDoctor();
    case "skill":
      if (p.positional[0] !== "install") fail("usage: message-use skill install");
      return installSkill();
    case "upgrade": return cmdUpgrade(p);
    case UPDATE_CHECK_COMMAND: return runUpdateCheck();
    case "version":
    case "--version":
      console.log(`message-use ${VERSION}`);
      return;
    case undefined:
    case "help":
    case "--help":
    case "-h":
      console.log(HELP);
      return;
    default:
      fail(`unknown command: ${command}\n\n${HELP}`);
  }
}

if (import.meta.main) await main();
