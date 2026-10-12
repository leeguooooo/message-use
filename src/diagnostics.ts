// Aggregate facts only: never expose message bodies, handles, paths or raw errors.
import { ChatDbError, appleDateToMs, msToAppleDate, openChatDb } from "./db.ts";

export const RECENT_WINDOW_SECONDS = 600;

export function databaseDiagnostics(afterId?: number) {
  const checkedAt = Date.now();
  const base = {
    checked_at: new Date(checkedAt).toISOString(),
    recent_window_seconds: RECENT_WINDOW_SECONDS,
  };
  try {
    const db = openChatDb();
    try {
      const row = db.query(`
        select count(*) message_count, max(case when date > 0 then date end) newest_date,
          sum(case when is_from_me = 0 and item_type = 0
            and coalesce(associated_message_type, 0) = 0 and date >= ? then 1 else 0 end) recent_count,
          sum(case when is_from_me = 0 and item_type = 0
            and coalesce(associated_message_type, 0) = 0 and ROWID > ? then 1 else 0 end) new_count
        from message`).get(msToAppleDate(checkedAt - RECENT_WINDOW_SECONDS * 1000), afterId ?? Number.MAX_SAFE_INTEGER) as {
          message_count: number; newest_date: number | null; recent_count: number | null; new_count: number | null;
        };
      const newest = appleDateToMs(row.newest_date);
      return {
        ...base,
        readable: true,
        error: null,
        message_count: row.message_count,
        newest_local_message_at: newest === null ? null : new Date(newest).toISOString(),
        newest_local_message_age_seconds: newest === null ? null : Math.max(0, Math.round((checkedAt - newest) / 1000)),
        recent_incoming_count: row.recent_count ?? 0,
        new_incoming_count: afterId === undefined ? null : row.new_count ?? 0,
      };
    } finally {
      db.close();
    }
  } catch (error) {
    return {
      ...base,
      readable: false,
      error: error instanceof ChatDbError ? error.code : "unreadable",
      message_count: null,
      newest_local_message_at: null,
      newest_local_message_age_seconds: null,
      recent_incoming_count: null,
      new_incoming_count: null,
    };
  }
}

export function diagnosticHint(db: ReturnType<typeof databaseDiagnostics>, senderFilterApplied?: boolean): string {
  if (!db.readable) {
    return db.error === "no-access"
      ? "Grant Full Disk Access to the terminal in System Settings, restart it, then run message-use doctor --json."
      : "Check that the local Messages database exists and is readable; run message-use doctor --json and retry.";
  }
  if (db.recent_incoming_count === 0) {
    return "No incoming messages are present in the local database in the last 10 minutes. This may be a quiet inbox; it does not establish a sync failure. Check whether the iPhone received the SMS, open Messages on this Mac, and check the same Apple account, iCloud Messages and Text Message Forwarding.";
  }
  if (senderFilterApplied === undefined) return "Recent incoming messages are present in the local database. This does not confirm receipt of a particular SMS or the current iPhone synchronization state.";
  return senderFilterApplied
    ? "Recent incoming messages are present, but no new verification code matched. Check the sender/brand filter or retry without --from; the awaited SMS may still be absent or its code format unrecognized."
    : "Recent incoming messages are present, but no new verification code matched. Check whether the awaited SMS reached this Mac; it may still be absent or its code format unrecognized.";
}
