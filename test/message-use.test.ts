import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractCode, smsBrand } from "../src/codes.ts";
import { appleDateToMs, decodeAttributedBody, msToAppleDate, phoneKey } from "../src/db.ts";
import { SKILL_MD } from "../src/skill.ts";
import { attributedBody, cleanupFixtures, makeFixture } from "./fixture.ts";

afterEach(cleanupFixtures);

const CLI = join(import.meta.dir, "..", "src", "cli.ts");

async function run(args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, CLI, ...args], { env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { code, stdout, stderr };
}

describe("attributedBody decoding", () => {
  test("short and long (0x81 length) bodies round-trip, CJK included", () => {
    expect(decodeAttributedBody(attributedBody("hello"))).toBe("hello");
    const long = "长".repeat(200);
    expect(decodeAttributedBody(attributedBody(long))).toBe(long);
  });
  test("garbage and truncated blobs return null instead of throwing", () => {
    expect(decodeAttributedBody(null)).toBeNull();
    expect(decodeAttributedBody(Buffer.from("no marker here"))).toBeNull();
    expect(decodeAttributedBody(attributedBody("hello").subarray(0, 60))).toBeNull();
  });
});

describe("dates and phone keys", () => {
  test("Apple epoch in nanoseconds and legacy seconds", () => {
    const now = Date.UTC(2026, 8, 29, 12);
    expect(appleDateToMs(msToAppleDate(now))).toBeCloseTo(now, -1);
    expect(appleDateToMs(0)).toBeNull();
    expect(appleDateToMs(100)).toBe(Date.UTC(2001, 0, 1) + 100_000);
  });
  test("phone keys ignore country prefixes and punctuation", () => {
    expect(phoneKey("+86 138-0013-8000")).toBe(phoneKey("13800138000"));
    expect(phoneKey("12")).toBeNull();
  });
});

describe("verification codes", () => {
  const cases: Array<[string, string | null]> = [
    ["【支付宝】验证码：482913，5分钟内有效，请勿泄露。", "482913"],
    ["【京东】482913是您的验证码，切勿告知他人。", "482913"],
    ["【微信支付】482913，谨防电信诈骗，勿轻信他人引导借款，不向陌生账户转账。该验证码5分钟内有效。", "482913"],
    ["Your Stripe verification code is: 482913. Don't share this code with anyone.", "482913"],
    ["[COCOS]Verification code: 4829, please complete the verification in 5 minutes.", "4829"],
    ["Here is the verification code for your Synology Account: 482913", "482913"],
    ["G-482913 is your Google verification code.", "482913"],
    ["Your code is 482913\n\n@example.com #482913", "482913"],
    ["【ゆうちょ銀行】ワンタイムパスワードは48291です。", "48291"],
    ["【人保财险】投保身份证采集生成的验证码为：VVB12F，请持此验证码进行投保确认。", "VVB12F"],
    // no code:
    ["【中国银行】可疑链接一律不点，索要验证码一律拒绝，投资返现一律不信。", null],
    ["【顺丰】您的快递 SF1234567890 已签收，如有疑问请致电 95338。", null],
    ["【招商银行】您账户1234于09月29日消费人民币2,380.00元。", null],
    ["Your order #48291 has shipped.", null],
    ["验证码 is not 12.50 or 99%", null],
  ];
  for (const [text, want] of cases) {
    test(`${want ?? "none"} ← ${text.slice(0, 40)}`, () => expect(extractCode(text)).toBe(want));
  }
  test("brand from the Chinese SMS signature", () => {
    expect(smsBrand("【支付宝】验证码：1234")).toBe("支付宝");
    expect(smsBrand("[PayPay]認証コード：1234")).toBe("PayPay");
    expect(smsBrand("plain text")).toBeNull();
  });
});

describe("commands (fixture database)", () => {
  test("chats: newest first, group named, unread counted", async () => {
    const f = makeFixture();
    f.addMessage({ chat: 1, handle: 1, text: "old", minutesAgo: 60 });
    f.addMessage({ chat: 4, handle: 2, text: "周六几点出发？", minutesAgo: 5 });
    const r = await run(["chats", "--json"], f.env);
    expect(r.code).toBe(0);
    const chats = JSON.parse(r.stdout);
    expect(chats[0]).toMatchObject({ id: 4, name: "周末爬山", group: true, unread: 1 });
    expect(chats[1]).toMatchObject({ id: 1, identifier: "+8613800138000", group: false });
  });

  test("history resolves a chat by number (any formatting), decodes body-only messages, oldest first", async () => {
    const f = makeFixture();
    f.addMessage({ chat: 1, handle: 1, text: "first", minutesAgo: 10 });
    f.addMessage({ chat: 1, handle: null, body: "only in attributedBody", fromMe: true, minutesAgo: 5 });
    const r = await run(["history", "138 0013 8000", "--json"], f.env);
    expect(r.code).toBe(0);
    const { chat, messages } = JSON.parse(r.stdout);
    expect(chat.id).toBe(1);
    expect(messages.map((m: { text: string }) => m.text)).toEqual(["first", "only in attributedBody"]);
    expect(messages[1]).toMatchObject({ from_me: true, sender: "me" });
  });

  test("search finds text in both columns", async () => {
    const f = makeFixture();
    f.addMessage({ chat: 2, handle: 2, text: "the parcel arrived" });
    f.addMessage({ chat: 2, handle: 2, body: "another PARCEL note" });
    f.addMessage({ chat: 2, handle: 2, text: "unrelated" });
    const r = await run(["search", "parcel", "--json"], f.env);
    expect(JSON.parse(r.stdout).map((m: { text: string }) => m.text).sort()).toEqual(["another PARCEL note", "the parcel arrived"]);
  });

  test("code: newest incoming code, --from filters by brand, own messages ignored", async () => {
    const f = makeFixture();
    f.addMessage({ chat: 3, handle: 3, text: "【京东】验证码：111111", minutesAgo: 3 });
    f.addMessage({ chat: 3, handle: 3, text: "【支付宝】验证码：222222", minutesAgo: 2 });
    f.addMessage({ chat: 1, handle: null, text: "验证码：999999", fromMe: true, minutesAgo: 1 });
    const newest = JSON.parse((await run(["code", "--json"], f.env)).stdout);
    expect(newest).toMatchObject({ code: "222222", brand: "支付宝" });
    const jd = JSON.parse((await run(["code", "--from", "京东", "--json"], f.env)).stdout);
    expect(jd.code).toBe("111111");
    const none = await run(["code", "--from", "淘宝"], f.env);
    expect(none.code).toBe(4);
  });

  test("code --wait ignores codes already there and returns the one that arrives", async () => {
    const f = makeFixture();
    f.addMessage({ chat: 3, handle: 3, text: "【支付宝】验证码：111111", minutesAgo: 1 });
    const proc = Bun.spawn([process.execPath, CLI, "code", "--wait", "15", "--json"], { env: { ...process.env, ...f.env }, stdout: "pipe", stderr: "pipe" });
    await new Promise((r) => setTimeout(r, 1500));
    f.addMessage({ chat: 3, handle: 3, text: "【支付宝】验证码：333333" });
    const out = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(out).code).toBe("333333");
  }, 20_000);

  test("send without --yes previews and sends nothing (exit 2); unknown numbers default to SMS", async () => {
    const f = makeFixture();
    const r = await run(["send", "--to", "+8613900000000", "--text", "hi"], f.env);
    expect(r.code).toBe(2);
    expect(r.stdout).toContain('would send to +8613900000000 via SMS: "hi"');
    expect(r.stdout).toContain("nothing sent");
    const im = await run(["send", "--to", "alice@example.com", "--text", "hi"], f.env);
    expect(im.stdout).toContain("via iMessage");
    const group = await run(["send", "--to", "周末爬山", "--text", "hi"], f.env);
    expect(group.stdout).toContain("would send to 周末爬山 via iMessage");
  });

  test("a missing database is a clear error with exit 3", async () => {
    const r = await run(["chats"], { MESSAGE_USE_CHAT_DB: "/nonexistent/chat.db", MESSAGE_USE_NO_UPDATE_CHECK: "1" });
    expect(r.code).toBe(3);
    expect(r.stderr).toContain("no Messages database");
  });
});

test("embedded skill is byte-identical to SKILL.md", () => {
  expect(SKILL_MD).toBe(readFileSync(join(import.meta.dir, "..", "SKILL.md"), "utf8"));
});
