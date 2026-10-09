import { notFound } from 'next/navigation';
import { SCREEN_ROUTES } from '@/lib/nav';

/**
 * Screen host. Phase 1 renders the real shell with an empty #view; each screen is ported in Phase 5
 * (order: docs/UI_PORT.md §4) by replacing this branch with its server page + client component.
 */
export default async function Screen({ params }: { params: Promise<{ screen: string }> }) {
  const { screen } = await params;
  if (!SCREEN_ROUTES.includes(screen)) notFound();
  return null;
}
