import { notFound } from 'next/navigation';
import { db } from '@/lib/db/client';
import { ApiError } from '@/lib/errors';
import { pageCtx } from '@/lib/page';
import { recipeDetail } from '@/lib/services/recipe-detail';
import { EditScreen } from '@/components/recipes/EditScreen';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const ctx = await pageCtx();
  let detail;
  try {
    detail = await recipeDetail(db, ctx.scope, id);
  } catch (e) {
    if (e instanceof ApiError && e.code === 'not_found') notFound();
    throw e;
  }
  const b = ctx.brands.find((x) => x.id === detail.recipe.brandId) ?? null;
  return (
    <EditScreen
      detail={detail}
      brand={
        b
          ? {
              id: b.id,
              name: b.name,
              nameAr: b.nameAr,
              color: b.color || '#BB5E1E',
              ink: b.inkColor,
              logoUrl: b.logoUrl,
            }
          : null
      }
      brands={ctx.brands.map((x) => ({ id: x.id, name: x.name, code: x.code }))}
    />
  );
}
