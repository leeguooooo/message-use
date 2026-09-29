// Verification-code extraction from SMS / iMessage text.
//
// Rules, in order of confidence:
//   1. a keyword (验证码 / 校验码 / 动态码 / code / OTP …) followed within 40 characters (no digits between) by 4–8 digits
//   2. 4–8 digits followed within 40 characters (no digits between) by such a keyword ("123456 是您的验证码", "123456 is your code")
//   3. well-known shapes: "G-123456" (Google), "#123456" at the end of a WebOTP line
// A message with no keyword at all never yields a code: order numbers, amounts and
// phone numbers are digits too. Digits glued to other digits, or part of an amount
// (¥12.50, 1,234) or a phone number, are ignored.

const KEYWORDS = [
  "验证码", "校验码", "动态码", "确认码", "认证码", "安全码", "激活码", "登录码", "短信码", "动态密码", "验证代码",
  "驗證碼", "認證碼", "確認碼",
  "認証コード", "確認コード", "認証番号", "ワンタイムパスワード",
  "verification code", "security code", "login code", "sign-in code", "signin code",
  "one-time code", "one time code", "one-time password", "passcode", "otp", "code",
];

const KEYWORD_RE = KEYWORDS.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
// Not part of a longer number, an amount (¥12.50, 1,234.00) or a percentage — but a
// sentence-ending "." or "," right after the code is fine ("code is 123456.").
const CODE = "(?<![\\d¥$€£]|\\d[.,])(\\d{4,8})(?!\\d|[.,]\\d|%)";
// Alphanumeric codes ("VVB12F"): 4–8 upper-case letters and digits with at least one of each,
// only accepted right after a keyword.
const ALNUM = "(?<![A-Za-z0-9])((?=[A-Z0-9]*\\d)(?=[A-Z0-9]*[A-Z])[A-Z0-9]{4,8})(?![A-Za-z0-9])";
// Keyword first: "验证码为：123456", "Your code is 123456", "code: 1234"
const AFTER_KEYWORD = new RegExp(`(?:${KEYWORD_RE})[^\\d\\n]{0,40}?${CODE}`, "iu");
// Case-sensitive on purpose: upper-case letters mark an alphanumeric code, ordinary words don't match.
const AFTER_KEYWORD_ALNUM = new RegExp(`(?:${KEYWORD_RE.replace(/\b/g, "")})[\\s:：为是is]{0,8}${ALNUM}`, "u");
// Code first: "123456是您的验证码", "123456 is your verification code"
const BEFORE_KEYWORD = new RegExp(`${CODE}[^\\d\\n]{0,40}?(?:${KEYWORD_RE})`, "iu");
const GOOGLE_STYLE = /\bG-(\d{5,8})\b/;
const WEB_OTP = /@[\w.-]+\s+#(\d{4,8})\s*$/m;

/** Brand in a Chinese SMS signature: "【支付宝】…" or "…【京东】". */
export function smsBrand(text: string): string | null {
  const m = /【([^】]{1,20})】/.exec(text) ?? /\[([^\]]{1,20})\]/.exec(text);
  return m ? m[1]!.trim() : null;
}

export function extractCode(text: string | null): string | null {
  if (!text) return null;
  const google = GOOGLE_STYLE.exec(text);
  if (google) return google[1]!;
  const webOtp = WEB_OTP.exec(text);
  if (webOtp) return webOtp[1]!;
  const after = AFTER_KEYWORD.exec(text);
  if (after) return after[1]!;
  const before = BEFORE_KEYWORD.exec(text);
  if (before) return before[1]!;
  const alnum = AFTER_KEYWORD_ALNUM.exec(text);
  if (alnum) return alnum[1]!;
  return null;
}
