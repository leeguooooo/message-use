// Read-only access to macOS Messages (~/Library/Messages/chat.db).
//
// The database is opened read-only; nothing here ever writes to it. Messages.app
// keeps it in WAL mode, so a read-only connection still sees rows committed a
// moment ago. Reading needs Full Disk Access for the terminal (or the app that
// runs message-use); `message-use doctor` explains how to grant it.

import { Database } from "bun:sqlite";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const CHAT_DB_ENV = "MESSAGE_USE_CHAT_DB";
export const CONTACTS_DIR_ENV = "MESSAGE_USE_CONTACTS_DIR";

export function chatDbPath(env: NodeJS.ProcessEnv = process.env): string {
  const override = env[CHAT_DB_ENV];
  return typeof override === "string" && override !== "" ? override : join(homedir(), "Library", "Messages", "chat.db");
}

export class ChatDbError extends Error {
  constructor(readonly code: "missing" | "no-access" | "unreadable", message: string) {
    super(message);
  }
}

export function openChatDb(env: NodeJS.ProcessEnv = process.env): Database {
  const path = chatDbPath(env);
  if (!existsSync(path)) throw new ChatDbError("missing", `no Messages database at ${path}`);
  try {
    const db = new Database(path, { readonly: true });
    db.query("select 1 from message limit 1").get();
    return db;
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    // Without Full Disk Access SQLite reports "unable to open" / "authorization denied".
    if (/unable to open|authorization|not authorized|permission/i.test(text)) {
      throw new ChatDbError("no-access", `cannot read ${path}: ${text}`);
    }
    throw new ChatDbError("unreadable", `cannot read ${path}: ${text}`);
  }
}

// Apple stores message dates as time since 2001-01-01, in nanoseconds on
// macOS 10.13+ and in seconds before that.
const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

export function appleDateToMs(value: number | bigint | null): number | null {
  if (value === null || value === undefined) return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return null;
  return APPLE_EPOCH_MS + (n > 1e12 ? n / 1e6 : n * 1000);
}

export function msToAppleDate(ms: number): number {
  return Math.round((ms - APPLE_EPOCH_MS) * 1e6);
}

/**
 * Newer macOS versions leave `message.text` NULL and keep the body in
 * `attributedBody`, an NSArchiver "typedstream" of an NSAttributedString.
 * The string is the first NSString payload: after the class name comes a
 * 5-byte header, then a length (1 byte, or 0x81 + uint16 LE, or 0x82 + uint32 LE).
 * Checked against 18,563 messages that also carry `text`: identical in all of them.
 */
export function decodeAttributedBody(blob: Uint8Array | null): string | null {
  if (blob === null || blob === undefined) return null;
  const b = Buffer.from(blob);
  const marker = b.indexOf("NSString");
  if (marker < 0) return null;
  let p = marker + "NSString".length + 5;
  if (p >= b.length) return null;
  let length = b[p]!;
  p += 1;
  if (length === 0x81) {
    if (p + 2 > b.length) return null;
    length = b.readUInt16LE(p);
    p += 2;
  } else if (length === 0x82) {
    if (p + 4 > b.length) return null;
    length = b.readUInt32LE(p);
    p += 4;
  }
  if (p + length > b.length) return null;
  return b.subarray(p, p + length).toString("utf8");
}

// ───────────────────────── contacts ─────────────────────────

/** Digits only, keeping the last 11 (drops +86 / +81 / trunk prefixes for matching). */
export function phoneKey(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 5) return null;
  return digits.slice(-11);
}

export type ContactBook = Map<string, string>;

/** Handle (phone key or lower-cased email) → display name, from every AddressBook source. */
export function loadContacts(env: NodeJS.ProcessEnv = process.env): ContactBook {
  const book: ContactBook = new Map();
  const base = env[CONTACTS_DIR_ENV] || join(homedir(), "Library", "Application Support", "AddressBook", "Sources");
  let sources: string[];
  try {
    sources = readdirSync(base);
  } catch {
    return book;
  }
  for (const source of sources) {
    const path = join(base, source, "AddressBook-v22.abcddb");
    if (!existsSync(path)) continue;
    let db: Database;
    try {
      db = new Database(path, { readonly: true });
    } catch {
      continue;
    }
    try {
      const nameOf = (r: { first: string | null; last: string | null; org: string | null }) => {
        const first = r.first ?? "";
        const last = r.last ?? "";
        // CJK names read family-name first with no space; others "First Last".
        const cjk = /[぀-ヿ㐀-鿿가-힯]/.test(first + last);
        const full = cjk ? `${last}${first}` : [first, last].filter(Boolean).join(" ");
        return (full.trim() || r.org || "").trim();
      };
      const phones = db.query(
        `select p.ZFULLNUMBER num, r.ZFIRSTNAME first, r.ZLASTNAME last, r.ZORGANIZATION org
         from ZABCDPHONENUMBER p join ZABCDRECORD r on r.Z_PK = p.ZOWNER`,
      ).all() as Array<{ num: string | null; first: string | null; last: string | null; org: string | null }>;
      for (const r of phones) {
        const key = r.num ? phoneKey(r.num) : null;
        const name = nameOf(r);
        if (key && name && !book.has(key)) book.set(key, name);
      }
      const emails = db.query(
        `select e.ZADDRESS addr, r.ZFIRSTNAME first, r.ZLASTNAME last, r.ZORGANIZATION org
         from ZABCDEMAILADDRESS e join ZABCDRECORD r on r.Z_PK = e.ZOWNER`,
      ).all() as Array<{ addr: string | null; first: string | null; last: string | null; org: string | null }>;
      for (const r of emails) {
        const name = nameOf(r);
        if (r.addr && name && !book.has(r.addr.toLowerCase())) book.set(r.addr.toLowerCase(), name);
      }
    } catch {
      // A source with an older schema: skip it.
    } finally {
      db.close();
    }
  }
  return book;
}

export function contactName(handle: string | null, book: ContactBook): string | null {
  if (!handle) return null;
  if (handle.includes("@")) return book.get(handle.toLowerCase()) ?? null;
  const key = phoneKey(handle);
  return key ? book.get(key) ?? null : null;
}

// ───────────────────────── queries ─────────────────────────

export interface Chat {
  id: number;
  guid: string;
  identifier: string;
  name: string | null;
  /** Participant handles (phone numbers / emails). */
  handles: string[];
  service: string | null;
  group: boolean;
  last_message_at: string | null;
  unread: number;
}

export interface Message {
  id: number;
  guid: string;
  chat_id: number | null;
  date: string | null;
  from_me: boolean;
  handle: string | null;
  sender: string | null;
  service: string | null;
  text: string | null;
  attachments: number;
  is_read: boolean;
}

interface RawMessage {
  id: number;
  guid: string;
  chat_id: number | null;
  date: number | null;
  is_from_me: number;
  handle: string | null;
  service: string | null;
  text: string | null;
  attributedBody: Uint8Array | null;
  attachments: number;
  is_read: number;
}

const MESSAGE_COLUMNS = `
  m.ROWID id, m.guid guid, cmj.chat_id chat_id, m.date date, m.is_from_me is_from_me,
  h.id handle, m.service service, m.text text, m.attributedBody attributedBody, m.is_read is_read,
  (select count(*) from message_attachment_join maj where maj.message_id = m.ROWID) attachments`;

const MESSAGE_FROM = `
  from message m
  left join handle h on h.ROWID = m.handle_id
  left join chat_message_join cmj on cmj.message_id = m.ROWID`;

// Tapbacks / reactions (associated_message_type 2000-3999) and system items (item_type != 0)
// are not conversation text.
const REAL_MESSAGE = `m.item_type = 0 and (m.associated_message_type is null or m.associated_message_type = 0)`;

function toMessage(r: RawMessage, book: ContactBook): Message {
  const ms = appleDateToMs(r.date);
  const text = r.text ?? decodeAttributedBody(r.attributedBody);
  return {
    id: r.id,
    guid: r.guid,
    chat_id: r.chat_id,
    date: ms === null ? null : new Date(ms).toISOString(),
    from_me: r.is_from_me === 1,
    handle: r.handle,
    sender: r.is_from_me === 1 ? "me" : contactName(r.handle, book) ?? r.handle,
    service: r.service,
    text: text === null ? null : text.replace(/￼/g, "").trim() || null,
    attachments: r.attachments,
    is_read: r.is_read === 1,
  };
}

export function listChats(db: Database, book: ContactBook, limit = 20): Chat[] {
  const rows = db.query(`
    select c.ROWID id, c.guid guid, c.chat_identifier identifier, c.display_name display_name,
           c.style style, c.service_name service,
           (select max(m.date) from chat_message_join cmj join message m on m.ROWID = cmj.message_id where cmj.chat_id = c.ROWID) last_date,
           (select count(*) from chat_message_join cmj join message m on m.ROWID = cmj.message_id
             where cmj.chat_id = c.ROWID and m.is_read = 0 and m.is_from_me = 0 and ${REAL_MESSAGE}) unread
    from chat c
    order by last_date desc
    limit ?`).all(limit) as Array<{
      id: number; guid: string; identifier: string; display_name: string | null; style: number;
      service: string | null; last_date: number | null; unread: number;
    }>;
  const handlesOf = db.query("select h.id id from chat_handle_join chj join handle h on h.ROWID = chj.handle_id where chj.chat_id = ?");
  return rows.map((r) => {
    const handles = (handlesOf.all(r.id) as Array<{ id: string }>).map((h) => h.id);
    const group = r.style === 43 || handles.length > 1;
    const named = r.display_name?.trim() ||
      (group ? handles.map((h) => contactName(h, book) ?? h).join(", ") : contactName(handles[0] ?? r.identifier, book));
    const ms = appleDateToMs(r.last_date);
    return {
      id: r.id,
      guid: r.guid,
      identifier: r.identifier,
      name: named || null,
      handles,
      service: r.service,
      group,
      last_message_at: ms === null ? null : new Date(ms).toISOString(),
      unread: r.unread,
    };
  });
}

/** Resolve a user-supplied chat reference: numeric id, exact handle/identifier, or name substring. */
export function resolveChat(db: Database, book: ContactBook, ref: string): Chat[] {
  const all = listChats(db, book, 100000);
  if (/^\d+$/.test(ref)) {
    const byId = all.filter((c) => c.id === Number(ref));
    if (byId.length > 0) return byId;
  }
  const lower = ref.toLowerCase();
  const key = phoneKey(ref);
  const exact = all.filter((c) =>
    c.identifier.toLowerCase() === lower ||
    c.guid.toLowerCase() === lower ||
    c.handles.some((h) => h.toLowerCase() === lower || (key !== null && phoneKey(h) === key))
  );
  if (exact.length > 0) return exact;
  return all.filter((c) => (c.name ?? "").toLowerCase().includes(lower));
}

export function chatHistory(
  db: Database,
  book: ContactBook,
  chatId: number,
  options: { limit?: number; sinceMs?: number } = {},
): Message[] {
  const since = options.sinceMs === undefined ? null : msToAppleDate(options.sinceMs);
  const rows = db.query(`
    select ${MESSAGE_COLUMNS} ${MESSAGE_FROM}
    where cmj.chat_id = ? and ${REAL_MESSAGE} ${since === null ? "" : "and m.date >= ?"}
    order by m.date desc limit ?`)
    .all(...(since === null ? [chatId, options.limit ?? 30] : [chatId, since, options.limit ?? 30])) as RawMessage[];
  return rows.map((r) => toMessage(r, book)).reverse();
}

/** Recent messages across all chats, newest first. */
export function recentMessages(
  db: Database,
  book: ContactBook,
  options: { sinceMs?: number; limit?: number; incomingOnly?: boolean; afterId?: number } = {},
): Message[] {
  const where = [REAL_MESSAGE];
  const params: Array<number> = [];
  if (options.sinceMs !== undefined) {
    where.push("m.date >= ?");
    params.push(msToAppleDate(options.sinceMs));
  }
  if (options.afterId !== undefined) {
    where.push("m.ROWID > ?");
    params.push(options.afterId);
  }
  if (options.incomingOnly) where.push("m.is_from_me = 0");
  params.push(options.limit ?? 50);
  const rows = db.query(`
    select ${MESSAGE_COLUMNS} ${MESSAGE_FROM}
    where ${where.join(" and ")}
    order by m.date desc limit ?`).all(...params) as RawMessage[];
  return rows.map((r) => toMessage(r, book));
}

/** Full-text search. Bodies that live only in attributedBody are decoded and matched in JS. */
export function searchMessages(
  db: Database,
  book: ContactBook,
  query: string,
  options: { limit?: number; sinceMs?: number } = {},
): Message[] {
  const limit = options.limit ?? 20;
  const needle = query.toLowerCase();
  const since = options.sinceMs === undefined ? null : msToAppleDate(options.sinceMs);
  const dateClause = since === null ? "" : "and m.date >= ?";
  const withText = db.query(`
    select ${MESSAGE_COLUMNS} ${MESSAGE_FROM}
    where ${REAL_MESSAGE} and m.text like ? escape '\\' ${dateClause}
    order by m.date desc limit ?`)
    .all(...([`%${query.replace(/[\\%_]/g, (c) => `\\${c}`)}%`, ...(since === null ? [] : [since]), limit] as Array<string | number>)) as RawMessage[];
  const bodyOnly = db.query(`
    select ${MESSAGE_COLUMNS} ${MESSAGE_FROM}
    where ${REAL_MESSAGE} and m.text is null and m.attributedBody is not null ${dateClause}
    order by m.date desc limit 5000`).all(...(since === null ? [] : [since])) as RawMessage[];
  const decoded = bodyOnly.filter((r) => (decodeAttributedBody(r.attributedBody) ?? "").toLowerCase().includes(needle));
  return [...withText, ...decoded]
    .sort((a, b) => Number(b.date ?? 0) - Number(a.date ?? 0))
    .slice(0, limit)
    .map((r) => toMessage(r, book));
}

export function maxMessageId(db: Database): number {
  return (db.query("select coalesce(max(ROWID), 0) id from message").get() as { id: number }).id;
}
