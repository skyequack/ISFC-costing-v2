'use client';

import { useRouter } from '@/components/shell/nav-progress';
import { useEffect } from 'react';

/** Legacy used the browser's own clock for "today". The server cannot know the user's time zone, so a page that needs it
 *  renders this and replaces the URL with the local date (once). */
export function RedirectToday({ base, params }: { base: string; params: Record<string, string> }) {
  const router = useRouter();
  useEffect(() => {
    const t = new Date();
    const q = new URLSearchParams({
      ...params,
      m: `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}`,
      d: String(t.getDate()).padStart(2, '0'),
    });
    router.replace(`${base}?${q.toString()}`);
  }, [router, base, params]);
  return null;
}

/** Like RedirectToday, for a screen keyed by one full date (`date=YYYY-MM-DD`, the user's own clock). */
export function RedirectTodayDate({ base, params }: { base: string; params: Record<string, string> }) {
  const router = useRouter();
  useEffect(() => {
    const t = new Date();
    const date = `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
    router.replace(`${base}?${new URLSearchParams({ ...params, date }).toString()}`);
  }, [router, base, params]);
  return null;
}
