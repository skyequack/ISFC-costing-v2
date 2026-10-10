// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const router = {
  push: vi.fn(),
  replace: vi.fn(),
  refresh: vi.fn(),
  back: vi.fn(),
  forward: vi.fn(),
  prefetch: vi.fn(),
};
vi.mock('next/navigation', () => ({ usePathname: () => '/dash', useRouter: () => router }));

import { NavProgressProvider, SkeletonMark, useRouter } from '@/components/shell/nav-progress';

const bar = () => document.querySelector('.navbar') as HTMLElement;

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.clearAllMocks();
});

function Page() {
  const [skeleton, setSkeleton] = useState(true);
  return (
    <>
      {skeleton && <SkeletonMark />}
      <button onClick={() => setSkeleton(false)}>arrive</button>
    </>
  );
}

describe('navigation progress bar', () => {
  it('is hidden at rest and does not flash for an instant page', () => {
    render(
      <NavProgressProvider>
        <div />
      </NavProgressProvider>,
    );
    expect(bar().className).toBe('navbar idle');
    expect(bar().getAttribute('aria-hidden')).toBe('true');
  });

  it('runs while a skeleton is on screen (after a short delay) and finishes when the real page replaces it', () => {
    render(
      <NavProgressProvider>
        <Page />
      </NavProgressProvider>,
    );
    expect(bar().className).toBe('navbar idle'); // < 120 ms: no flash
    act(() => vi.advanceTimersByTime(150));
    expect(bar().className).toBe('navbar run');
    expect(bar().getAttribute('aria-busy')).toBe('true');
    act(() => screen.getByText('arrive').click());
    expect(bar().className).toBe('navbar finish');
    act(() => vi.advanceTimersByTime(400));
    expect(bar().className).toBe('navbar idle');
  });

  it('a page that arrives within the delay never shows the bar', () => {
    render(
      <NavProgressProvider>
        <Page />
      </NavProgressProvider>,
    );
    act(() => vi.advanceTimersByTime(60));
    act(() => screen.getByText('arrive').click());
    act(() => vi.advanceTimersByTime(600));
    expect(bar().className).toBe('navbar idle');
  });

  it('the wrapped router still calls push / replace / refresh with the same arguments', () => {
    function Buttons() {
      const r = useRouter();
      return (
        <>
          <button onClick={() => r.push('/edit/1')}>push</button>
          <button onClick={() => r.replace('/prep?d=2')}>replace</button>
          <button onClick={() => r.refresh()}>refresh</button>
        </>
      );
    }
    render(
      <NavProgressProvider>
        <Buttons />
      </NavProgressProvider>,
    );
    act(() => screen.getByText('push').click());
    act(() => screen.getByText('replace').click());
    act(() => screen.getByText('refresh').click());
    expect(router.push).toHaveBeenCalledWith('/edit/1', undefined);
    expect(router.replace).toHaveBeenCalledWith('/prep?d=2', undefined);
    expect(router.refresh).toHaveBeenCalledTimes(1);
  });

  it('outside the provider it is the plain router', () => {
    function One() {
      const r = useRouter();
      return <button onClick={() => r.push('/x')}>go</button>;
    }
    render(<One />);
    act(() => screen.getByText('go').click());
    expect(router.push).toHaveBeenCalledWith('/x');
  });
});
