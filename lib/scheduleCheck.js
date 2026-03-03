'use strict';

/**
 * Schedule window check — timezone-aware.
 *
 * Determines whether the current time falls within the client's
 * configured alert window. Uses the IANA timezone stored in config.
 *
 * No external dependencies — uses Intl.DateTimeFormat which is
 * available in Node.js 20 without any npm packages.
 */

/**
 * @param {object} schedule  From configs/{dbName}.schedule
 *   {
 *     enabled:   boolean
 *     days:      number[]   0=Sun … 6=Sat
 *     startTime: string     "HH:MM" (24h)
 *     endTime:   string     "HH:MM" (24h)
 *     timezone:  string     IANA e.g. "America/Mexico_City"
 *   }
 * @param {Date}   [now]     Defaults to current time. Inject for testing.
 * @returns {{ inWindow: boolean, reason: string }}
 */
function isInScheduleWindow(schedule, now = new Date()) {
  // If scheduling is disabled, always in window
  if (!schedule || !schedule.enabled) {
    return { inWindow: true, reason: 'scheduling disabled' };
  }

  const tz = schedule.timezone || 'UTC';

  // Get current time components in the configured timezone
  let localParts;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone:    tz,
      weekday:     'short',
      hour:        'numeric',
      minute:      'numeric',
      hour12:      false
    });

    // Parse formatted parts
    const parts = {};
    fmt.formatToParts(now).forEach(p => { parts[p.type] = p.value; });

    const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    const dayOfWeek = dayMap[parts.weekday] ?? now.getDay();
    const hour = parseInt(parts.hour, 10) % 24;
    const minute    = parseInt(parts.minute, 10);
    const nowMinutes = hour * 60 + minute;

    localParts = { dayOfWeek, nowMinutes };
  } catch (err) {
    // Intl error (invalid timezone) — fail open, allow the call
    console.warn(`[schedule] Timezone error for "${tz}": ${err.message} — defaulting to in-window`);
    return { inWindow: true, reason: `timezone error: ${err.message}` };
  }

  // Check day of week
  const activeDays = schedule.days || [1, 2, 3, 4, 5];
  if (!activeDays.includes(localParts.dayOfWeek)) {
    return {
      inWindow: false,
      reason:   `today (day ${localParts.dayOfWeek}) not in active days [${activeDays.join(',')}]`
    };
  }

  // Parse start/end times to minutes-since-midnight
  const [startH, startM] = (schedule.startTime || '00:00').split(':').map(Number);
  const [endH,   endM  ] = (schedule.endTime   || '23:59').split(':').map(Number);
  const startMinutes = startH * 60 + startM;
  const endMinutes   = endH   * 60 + endM;
  const nowMinutes   = localParts.nowMinutes;

  // Handle overnight windows (e.g. 22:00 – 06:00)
  let inTimeWindow;
  if (startMinutes <= endMinutes) {
    inTimeWindow = nowMinutes >= startMinutes && nowMinutes < endMinutes;
  } else {
    // Overnight: in window if after start OR before end
    inTimeWindow = nowMinutes >= startMinutes || nowMinutes < endMinutes;
  }

  if (!inTimeWindow) {
    return {
      inWindow: false,
      reason:   `current time ${Math.floor(nowMinutes / 60)}:${String(nowMinutes % 60).padStart(2,'0')} outside window ${schedule.startTime}–${schedule.endTime} (${tz})`
    };
  }

  return { inWindow: true, reason: 'within schedule window' };
}

module.exports = { isInScheduleWindow };
