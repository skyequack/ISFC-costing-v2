import type { CSSProperties } from 'react';
import { SkeletonMark } from './nav-progress';

/**
 * Route skeletons (loading.tsx): the same legacy blocks as the real screens (.kpis/.kpi, .card, table, .btile, .tw)
 * with shimmering bars instead of content. No text at all. The header title already comes from the route.
 */
type Kind = 'dash' | 'list' | 'editor' | 'cards' | 'form' | 'sheet';

const bar = (w: number | string, h = 12, extra?: CSSProperties) => (
  <span className="sk" style={{ width: w, height: h, ...extra }} />
);

function Rows({ n, cols }: { n: number; cols: (number | string)[] }) {
  return (
    <>
      {Array.from({ length: n }, (_, i) => (
        <tr key={i}>
          {cols.map((w, j) => (
            <td key={j}>{bar(typeof w === 'number' && j === 1 ? w - (i % 3) * 18 : w, 12)}</td>
          ))}
        </tr>
      ))}
    </>
  );
}

function Table({ head, rows, cols }: { head: number; rows: number; cols: (number | string)[] }) {
  return (
    <div className="tw">
      <table>
        <thead>
          <tr>
            {Array.from({ length: head }, (_, i) => (
              <th key={i}>{bar('55%', 9)}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          <Rows n={rows} cols={cols} />
        </tbody>
      </table>
    </div>
  );
}

function Toolbar({ boxes }: { boxes: number }) {
  return (
    <div className="sk-bar">
      {Array.from({ length: boxes }, (_, i) => (
        <span key={i} className="sk" style={{ width: i === 0 ? 240 : 150, height: 36, borderRadius: 9 }} />
      ))}
    </div>
  );
}

function Body({ kind }: { kind: Kind }) {
  switch (kind) {
    case 'dash':
      return (
        <>
          <div className="kpis">
            {Array.from({ length: 6 }, (_, i) => (
              <div className="kpi" key={i}>
                {bar('55%', 10)}
                {bar('40%', 24, { marginTop: 9 })}
                {bar('75%', 10, { marginTop: 8 })}
              </div>
            ))}
          </div>
          <Table head={7} rows={9} cols={[70, 190, 90, 30, 60, 60, 60]} />
        </>
      );
    case 'list':
      return (
        <>
          <Toolbar boxes={3} />
          <Table head={8} rows={12} cols={[80, 200, 90, 50, 70, 60, 60, 80]} />
        </>
      );
    case 'sheet':
      return (
        <>
          <Toolbar boxes={4} />
          <div className="card" style={{ marginBottom: 16 }}>
            <div className="bd">
              <div className="sk-row">{bar('30%', 14)}</div>
            </div>
          </div>
          <Table head={5} rows={8} cols={[230, 80, 90, 80, 80]} />
        </>
      );
    case 'editor':
      return (
        <div className="sk-split">
          <div>
            <div className="card" style={{ marginBottom: 18 }}>
              <div className="bd">
                <div className="sk-row" style={{ marginBottom: 18 }}>
                  {bar(56, 56, { borderRadius: 10 })}
                  <div style={{ flex: 1 }}>
                    {bar('45%', 18)}
                    {bar('70%', 11, { marginTop: 8 })}
                  </div>
                </div>
                <div className="sk-bar">
                  {bar(160, 36, { borderRadius: 9 })}
                  {bar(260, 36, { borderRadius: 9 })}
                  {bar(160, 36, { borderRadius: 9 })}
                </div>
                <div className="sk-bar" style={{ marginBottom: 0 }}>
                  {bar(160, 36, { borderRadius: 9 })}
                  {bar(160, 36, { borderRadius: 9 })}
                </div>
              </div>
            </div>
            <Table head={7} rows={5} cols={[110, 180, 60, 70, 70, 70, 80]} />
          </div>
          <div className="card">
            <div className="bd">
              {Array.from({ length: 9 }, (_, i) => (
                <div className="sk-row" key={i} style={{ justifyContent: 'space-between', marginBottom: 13 }}>
                  {bar('42%', 11)}
                  {bar('22%', 11)}
                </div>
              ))}
            </div>
          </div>
        </div>
      );
    case 'cards':
      return (
        <div className="bgrid">
          {Array.from({ length: 8 }, (_, i) => (
            <div className="btile" key={i} style={{ cursor: 'default' }}>
              {bar(80, 34, { marginBottom: 12, borderRadius: 8 })}
              {bar('65%', 16)}
              {bar('40%', 11, { marginTop: 9 })}
            </div>
          ))}
        </div>
      );
    case 'form':
      return (
        <>
          {Array.from({ length: 3 }, (_, i) => (
            <div className="card" key={i} style={{ marginBottom: 18 }}>
              <h3>{bar('22%', 11, { background: 'rgba(143,71,22,.18)', animation: 'none' })}</h3>
              <div className="bd">
                {Array.from({ length: 3 }, (_, j) => (
                  <div className="sk-row" key={j} style={{ marginBottom: 14 }}>
                    {bar('26%', 11)}
                    {bar('34%', 34, { borderRadius: 9 })}
                  </div>
                ))}
              </div>
            </div>
          ))}
        </>
      );
  }
}

export function SkeletonPage({ kind }: { kind: Kind }) {
  return (
    <div className="sk-page" aria-hidden="true" data-skeleton={kind}>
      <SkeletonMark />
      <Body kind={kind} />
    </div>
  );
}
