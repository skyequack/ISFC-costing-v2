/** Structured JSON logs. Never pass request bodies, photos or secrets. */
export type LogFields = {
  reqId?: string;
  clerkUserId?: string | null;
  route?: string;
  status?: number;
  ms?: number;
  [k: string]: unknown;
};

export function log(level: 'info' | 'warn' | 'error', msg: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ level, msg, t: new Date().toISOString(), ...fields });
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)(line);
}
