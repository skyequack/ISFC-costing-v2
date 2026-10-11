// @vitest-environment jsdom
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { calls, installFetch, nav, renderInShell, resetFetch } from './harness';

vi.mock('next/navigation', () => ({
  usePathname: () => nav.path,
  useRouter: () => ({ push: nav.push, replace: nav.replace, refresh: nav.refresh }),
}));
vi.mock('@clerk/nextjs', () => ({ useClerk: () => ({ signOut: vi.fn() }) }));

import { UsersScreen } from '@/components/screens/UsersScreen';
import type { InviteRow, UserRow } from '@/lib/services/users';

beforeAll(() => {
  installFetch();
  window.scrollTo = vi.fn();
});
beforeEach(() => resetFetch());
afterEach(() => cleanup());

const brands = [
  { id: 'b1', name: 'Gourmet', code: 'GO' },
  { id: 'b2', name: 'Other', code: 'OT' },
];
const me: UserRow = {
  id: 'c-me',
  name: 'Gina GM',
  email: 'gm@x.test',
  role: 'gm',
  banned: false,
  appUserId: 'a1',
  active: true,
  brandIds: [],
  isYou: true,
};
const inv: InviteRow = { id: 'inv_1', email: 'new@x.test', role: 'chef', brandIds: ['b2'] };

describe('Users tab: pending invitations (D-78..D-81)', () => {
  it('lists the invitation after the users with a pending pill, its role and brands', () => {
    renderInShell(<UsersScreen users={[me]} invites={[inv]} brands={brands} />, 'gm');
    const row = screen.getByText('new@x.test').closest('tr')!;
    expect(within(row).getByText('pending')).toBeTruthy();
    expect(within(row).getByText('OT')).toBeTruthy();
    expect(within(row).getByText('Edit access')).toBeTruthy();
    expect(within(row).getByText('Revoke invite')).toBeTruthy();
    expect(within(row).queryByText('Suspend')).toBeNull();
    expect(screen.getByText('1 invitation pending.')).toBeTruthy();
  });

  it('revoke asks first, then deletes the invitation', async () => {
    renderInShell(<UsersScreen users={[me]} invites={[inv]} brands={brands} />, 'gm');
    fireEvent.click(screen.getByText('Revoke invite'));
    expect(screen.getByText('Revoke this invitation?')).toBeTruthy();
    expect(calls).toHaveLength(0);
    fireEvent.click(screen.getByText('Revoke'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE')).toBe(true));
    expect(calls.find((c) => c.method === 'DELETE')!.url).toBe('/api/users/invites/inv_1');
  });

  it('edit access: Select all brands ticks every box, and the save sends the role and brands', async () => {
    renderInShell(<UsersScreen users={[me]} invites={[inv]} brands={brands} />, 'gm');
    fireEvent.click(screen.getByText('Edit access'));
    const all = screen.getByLabelText('Select all brands') as HTMLInputElement;
    expect(all.checked).toBe(false);
    fireEvent.click(all);
    expect((screen.getByLabelText('Gourmet') as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText('Other') as HTMLInputElement).checked).toBe(true);
    fireEvent.click(screen.getByText('Save'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PATCH')).toBe(true));
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      url: '/api/users/invites/inv_1',
      body: { brandIds: ['b1', 'b2'] },
    });
  });

  it('invite form: brands are chosen before sending and are not pre-ticked', async () => {
    renderInShell(<UsersScreen users={[me]} brands={brands} />, 'gm');
    fireEvent.click(screen.getByText('+ Invite User'));
    expect((screen.getByLabelText('Select all brands') as HTMLInputElement).checked).toBe(false);
    fireEvent.change(screen.getByPlaceholderText('name@company.com'), { target: { value: 'a@b.co' } });
    fireEvent.click(screen.getByLabelText('Gourmet'));
    fireEvent.click(screen.getByText('Send invitation'));
    await waitFor(() => expect(calls.some((c) => c.method === 'POST')).toBe(true));
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/users/invite',
      body: { email: 'a@b.co', role: 'viewer', brandIds: ['b1'] },
    });
  });
});
