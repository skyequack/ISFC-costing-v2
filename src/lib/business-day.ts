/**
 * D-100: "today" for revisions and dated prices is the business day in Saudi Arabia (UTC+3, no daylight saving), not the
 * database session's UTC day, so a card saved at 22:00 local does not start tomorrow. Dates are calendar days.
 */
export const BUSINESS_TZ = 'Asia/Riyadh';

/** SQL expression for today's business day (a `date`). */
export const TODAY_SQL = `((now() AT TIME ZONE '${BUSINESS_TZ}')::date)`;

/** Today's business day as YYYY-MM-DD, for screens (the server decides; this only hides a button that would be refused). */
export function businessToday(now: Date = new Date()): string {
  return now.toLocaleDateString('en-CA', { timeZone: BUSINESS_TZ });
}
