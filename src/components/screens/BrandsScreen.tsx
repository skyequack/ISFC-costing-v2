'use client';

import { useRouter } from 'next/navigation';
import { Acts } from '@/components/shell/Shell';
import { api, errText } from '@/components/shared/api-client';
import { useToast } from '@/components/shared/Toast';
import { pct } from '@/lib/format';
import type { BrandTile } from '@/lib/screens/brands';

/** Legacy vBrands (2564): one tile per brand; clicking sets the workspace (cookie) and opens the recipe list. */
export function BrandsScreen({
  tiles,
  workspaceId,
  target,
}: {
  tiles: BrandTile[];
  workspaceId: string;
  target: number;
}) {
  const router = useRouter();
  const toast = useToast();

  async function pick(id: string, name: string) {
    try {
      await api('POST', '/api/workspace', { brandId: id });
      toast('Working in ' + name);
      router.push('/recipes');
      router.refresh();
    } catch (e) {
      toast(errText(e));
    }
  }

  return (
    <>
      <Acts>
        <button className="btn o" onClick={() => router.push('/settings')}>
          Manage brands
        </button>
      </Acts>
      <div className="note">
        Every recipe card belongs to one brand. Choose a workspace and the system scopes the recipe list, the new-card
        button and the code numbering to that brand.
      </div>
      <div className="bgrid">
        {tiles.map((b) => {
          const ac = b.color || 'var(--org)';
          return (
            <div
              key={b.id}
              className={`btile ${workspaceId === b.id ? 'on' : ''}`}
              onClick={() => pick(b.id, b.name)}
              style={{ borderTopColor: ac }}
            >
              <div className="bt-h">
                <span className="bt-code" style={{ background: ac, color: b.onSolid }}>
                  {b.code}
                </span>
                {workspaceId === b.id && <span className="pill p-ok">active</span>}
              </div>
              {b.logoUrl && (
                <div className="bt-logo">
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={b.logoUrl} alt="" />
                </div>
              )}
              <h3 style={{ color: b.text }}>{b.name}</h3>
              {b.nameAr && (
                <div className="bt-ar" dir="rtl">
                  {b.nameAr}
                </div>
              )}
              <div className="bt-n">
                <b>{b.cards}</b> recipe card{b.cards === 1 ? '' : 's'}
                {b.menus ? ` · ${b.menus} menu` : ''}
              </div>
              <div className="bt-s">
                <div>
                  <span>Avg FC</span>
                  <b className={b.afc == null ? '' : b.afc <= target ? 'ok' : 'bad'}>{pct(b.afc)}</b>
                </div>
                <div>
                  <span>Over target</span>
                  <b className={b.over ? 'bad' : 'ok'}>{b.over}</b>
                </div>
                <div>
                  <span>Locked</span>
                  <b>
                    {b.locked}/{b.cards}
                  </b>
                </div>
              </div>
              <div className="bt-go">Open workspace {'→'}</div>
            </div>
          );
        })}
        <div className="btile add" onClick={() => router.push('/settings')}>
          <div className="plus">+</div>
          <h3>Add a brand</h3>
          <div className="bt-n">Manage brands and their code prefixes in Cost Settings</div>
        </div>
      </div>
    </>
  );
}
