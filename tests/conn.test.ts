import { describe, expect, it } from 'vitest';
import { normalizeConnectionString } from '@/lib/db/conn';

describe('normalizeConnectionString', () => {
  const base = 'postgresql://user:p%40ss@ep-x-pooler.eu-central-1.aws.neon.tech/neondb';

  it.each(['require', 'prefer', 'verify-ca'])('rewrites sslmode=%s to verify-full', (mode) => {
    expect(new URL(normalizeConnectionString(`${base}?sslmode=${mode}`)).searchParams.get('sslmode')).toBe(
      'verify-full',
    );
  });

  it('keeps verify-full, disable and other parameters, and credentials', () => {
    expect(normalizeConnectionString(`${base}?sslmode=verify-full`)).toContain('sslmode=verify-full');
    expect(normalizeConnectionString(`${base}?sslmode=disable`)).toContain('sslmode=disable');
    const out = normalizeConnectionString(`${base}?sslmode=require&channel_binding=require`);
    expect(out).toContain('channel_binding=require');
    expect(out).toContain('user:p%40ss@');
  });

  it('leaves URLs without sslmode alone', () => {
    expect(normalizeConnectionString(base)).toBe(base);
  });
});
