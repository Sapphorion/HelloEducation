// Shared helpers for one-off tutoring sessions (the `sessions` collection).

// A booked session stores only its start time (`scheduledAt`), no end time,
// so we assume every session runs 90 minutes.
export const ASSUMED_SESSION_DURATION_MS = 90 * 60 * 1000;

// How long after a session has finished its "Join session" / "Meeting link"
// link stays usable. After this grace period the link is treated as expired
// and hidden everywhere it would otherwise be shown.
export const MEETING_LINK_GRACE_MS = 60 * 60 * 1000;

function sessionStartMs(session) {
  const value = session && session.scheduledAt;
  if (!value) return NaN;
  if (typeof value.toDate === 'function') return value.toDate().getTime();
  if (typeof value.toMillis === 'function') return value.toMillis();
  return new Date(value).getTime();
}

// True while a session's meeting link should still be shown: from any time
// before the session up until 90 minutes (assumed length) plus a 1 hour grace
// period after its start time. Returns false once that window has passed, or if
// the session simply has no link. Callers that already gate on `meetingLink`
// truthiness can call this directly instead.
export function isMeetingLinkVisible(session, now = Date.now()) {
  if (!session || !session.meetingLink) return false;
  const startMs = sessionStartMs(session);
  if (Number.isNaN(startMs)) return false;
  return now < startMs + ASSUMED_SESSION_DURATION_MS + MEETING_LINK_GRACE_MS;
}
