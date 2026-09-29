// A throwaway Messages database with the real schema subset message-use reads.
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { msToAppleDate } from "../src/db.ts";

const dirs: string[] = [];
export function cleanupFixtures(): void {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
}

/** NSArchiver typedstream shape: … "NSString" + 5 header bytes + length + UTF-8. */
export function attributedBody(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const len = body.length < 0x80
    ? Buffer.from([body.length])
    : Buffer.concat([Buffer.from([0x81]), Buffer.from([body.length & 0xff, body.length >> 8])]);
  return Buffer.concat([
    Buffer.from([0x04, 0x0b]), Buffer.from("streamtyped"), Buffer.from([0x81, 0xe8, 0x03, 0x84, 0x01, 0x40, 0x84, 0x84, 0x84]),
    Buffer.from("NSAttributedString"), Buffer.from([0x00, 0x84, 0x84]), Buffer.from("NSObject"), Buffer.from([0x00, 0x85, 0x92, 0x84, 0x84, 0x84]),
    Buffer.from("NSString"), Buffer.from([0x01, 0x94, 0x84, 0x01, 0x2b]), len, body, Buffer.from([0x86, 0x84]),
  ]);
}

export interface Fixture {
  path: string;
  env: Record<string, string>;
  addMessage(input: { chat: number; handle: number | null; text?: string; body?: string; fromMe?: boolean; minutesAgo?: number }): number;
}

export function makeFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "message-use-test-"));
  dirs.push(dir);
  const path = join(dir, "chat.db");
  const db = new Database(path);
  db.exec(`
    create table handle (ROWID integer primary key, id text, country text, service text, uncanonicalized_id text, person_centric_id text);
    create table chat (ROWID integer primary key, guid text, style integer, chat_identifier text, service_name text, room_name text, display_name text, group_id text);
    create table message (ROWID integer primary key, guid text, text text, handle_id integer, country text, attributedBody blob,
      service text, date integer, date_read integer, is_from_me integer, is_read integer, cache_roomnames text, item_type integer default 0,
      associated_message_guid text, associated_message_type integer default 0, balloon_bundle_id text, expressive_send_style_id text, thread_originator_guid text);
    create table chat_message_join (chat_id integer, message_id integer);
    create table chat_handle_join (chat_id integer, handle_id integer);
    create table attachment (ROWID integer primary key, guid text, filename text, mime_type text, transfer_name text, total_bytes integer);
    create table message_attachment_join (message_id integer, attachment_id integer);
    insert into handle values (1, '+8613800138000', 'cn', 'SMS', null, null);
    insert into handle values (2, 'alice@example.com', null, 'iMessage', null, null);
    insert into handle values (3, '106980095188', 'cn', 'SMS', null, null);
    insert into handle values (4, '+819012345678', 'jp', 'iMessage', null, null);
    insert into chat values (1, 'SMS;-;+8613800138000', 45, '+8613800138000', 'SMS', null, null, null);
    insert into chat values (2, 'iMessage;-;alice@example.com', 45, 'alice@example.com', 'iMessage', null, null, null);
    insert into chat values (3, 'SMS;-;106980095188', 45, '106980095188', 'SMS', null, null, null);
    insert into chat values (4, 'iMessage;+;chat123', 43, 'chat123', 'iMessage', null, '周末爬山', null);
    insert into chat_handle_join values (1,1),(2,2),(3,3),(4,2),(4,4);
  `);
  db.close();
  let next = 1;
  return {
    path,
    env: { MESSAGE_USE_CHAT_DB: path, MESSAGE_USE_CONTACTS_DIR: join(dir, "no-contacts"), MESSAGE_USE_NO_UPDATE_CHECK: "1" },
    addMessage(input) {
      const w = new Database(path);
      const id = next++;
      const service = input.chat === 1 || input.chat === 3 ? "SMS" : "iMessage";
      w.query(`insert into message (ROWID, guid, text, handle_id, attributedBody, service, date, is_from_me, is_read, item_type, associated_message_type)
               values (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0)`).run(
        id, `guid-${id}`, input.text ?? null, input.fromMe ? 0 : input.handle,
        input.body !== undefined ? attributedBody(input.body) : input.text !== undefined ? attributedBody(input.text) : null,
        service, msToAppleDate(Date.now() - (input.minutesAgo ?? 0) * 60_000), input.fromMe ? 1 : 0, input.fromMe ? 1 : 0,
      );
      w.query("insert into chat_message_join values (?, ?)").run(input.chat, id);
      w.close();
      return id;
    },
  };
}
