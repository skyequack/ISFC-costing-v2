'use client';

import { Perm } from '@/components/shared/Perm';
import { useNewRecipe } from './NewRecipe';

/** `data-perm="recipe.create"` button that opens the New recipe card dialog. */
export function NewRecipeButton({ label = '+ New Recipe Card' }: { label?: string }) {
  const open = useNewRecipe();
  return (
    <Perm perm="recipe.create">
      <button className="btn" onClick={open}>
        {label}
      </button>
    </Perm>
  );
}
