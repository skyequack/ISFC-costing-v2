import { z } from 'zod';

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  DATABASE_URL_UNPOOLED: z.string().min(1),
  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY: z.string().min(1),
  CLERK_SECRET_KEY: z.string().min(1),
  INITIAL_GM_EMAILS: z.string().default(''),
});

export type Env = z.infer<typeof schema> & { initialGmEmails: string[] };

let cached: Env | undefined;

/** Validated server env. Lazy so `next build` and unit tests do not need secrets until first use. */
export function getEnv(source: NodeJS.ProcessEnv = process.env): Env {
  if (source === process.env && cached) return cached;
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const names = parsed.error.issues.map((i) => i.path.join('.')).join(', ');
    throw new Error(`Invalid environment: ${names}`); // names only — never values
  }
  const env: Env = {
    ...parsed.data,
    initialGmEmails: parsed.data.INITIAL_GM_EMAILS.split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  };
  if (source === process.env) cached = env;
  return env;
}
