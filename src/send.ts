// Sending through Messages.app's AppleScript surface.
//
// Recipient and text are passed as argv to `osascript`, never spliced into the script,
// so quotes, newlines or AppleScript in a message body cannot change what runs.
// The first send asks macOS for Automation permission ("… wants to control Messages").
// SMS needs "Text Message Forwarding" enabled for this Mac on the paired iPhone.

import { spawnSync } from "node:child_process";

export type SendService = "auto" | "iMessage" | "SMS";

const SEND_TO_HANDLE = `
on run argv
  set theHandle to item 1 of argv
  set theText to item 2 of argv
  set theService to item 3 of argv
  tell application "Messages"
    if theService is "SMS" then
      set theAccount to 1st account whose service type = SMS
    else
      set theAccount to 1st account whose service type = iMessage
    end if
    send theText to participant theHandle of theAccount
  end tell
end run`;

const SEND_TO_CHAT = `
on run argv
  set theGuid to item 1 of argv
  set theText to item 2 of argv
  tell application "Messages"
    send theText to chat id theGuid
  end tell
end run`;

const SEND_FILE_TO_HANDLE = `
on run argv
  set theHandle to item 1 of argv
  set thePath to item 2 of argv
  set theService to item 3 of argv
  tell application "Messages"
    if theService is "SMS" then
      set theAccount to 1st account whose service type = SMS
    else
      set theAccount to 1st account whose service type = iMessage
    end if
    send (POSIX file thePath) to participant theHandle of theAccount
  end tell
end run`;

export type SendResult = { ok: true } | { ok: false; error: string };

function runOsascript(script: string, args: string[]): SendResult {
  const out = spawnSync("osascript", ["-e", script, "--", ...args], { encoding: "utf8", timeout: 30_000 });
  if (out.error) return { ok: false, error: out.error.message };
  if (out.status !== 0) {
    const stderr = (out.stderr ?? "").trim();
    if (/-1743|not authori[sz]ed/i.test(stderr)) {
      return {
        ok: false,
        error: "macOS blocked controlling Messages: allow it in System Settings › Privacy & Security › Automation (for your terminal → Messages)",
      };
    }
    return { ok: false, error: stderr || `osascript exited ${out.status}` };
  }
  return { ok: true };
}

/**
 * A phone number or email is sent through the chosen service; `auto` picks iMessage for
 * email addresses and for handles we have iMessage history with, SMS otherwise.
 */
export function sendToHandle(handle: string, text: string, service: "iMessage" | "SMS"): SendResult {
  return runOsascript(SEND_TO_HANDLE, [handle, text, service]);
}

export function sendToChat(chatGuid: string, text: string): SendResult {
  return runOsascript(SEND_TO_CHAT, [chatGuid, text]);
}

export function sendFileToHandle(handle: string, path: string, service: "iMessage" | "SMS"): SendResult {
  return runOsascript(SEND_FILE_TO_HANDLE, [handle, path, service]);
}
