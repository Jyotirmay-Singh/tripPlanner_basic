/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Component test for the soft-gate banner (src/UnverifiedBanner.tsx): it renders only for a
// genuinely-unverified user (email_verified === false) and the resend action hits the endpoint.
const mockToast = { show: jest.fn() };
let mockUser: any = null;
const mockRefresh = jest.fn().mockResolvedValue(undefined);

jest.mock('../../api', () => ({ api: jest.fn() }));
jest.mock('../../AuthContext', () => ({ useAuth: () => ({ user: mockUser, refresh: mockRefresh }) }));
jest.mock('../../ThemeContext', () => ({ useTheme: () => ({ colors: { surfaceMuted: '#eee', warning: '#fa0' } }) }));
jest.mock('../../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(Text, null, p.children) };
});
jest.mock('../../ui', () => {
  const R = require('react');
  return {
    __esModule: true,
    Icon: (p: any) => R.createElement('Icon', p),
    Button: (p: any) => R.createElement('Button', p),
    useToast: () => mockToast,
  };
});

import UnverifiedBanner from '../../UnverifiedBanner';
import { api } from '../../api';

const apiMock = api as unknown as jest.Mock;
const node = (r: any, id: string) =>
  r.root.find((n: any) => typeof n.type === 'string' && n.props.testID === id);
const has = (r: any, id: string) =>
  r.root.findAll((n: any) => n.props && n.props.testID === id).length > 0;

beforeEach(() => {
  mockToast.show.mockClear(); mockRefresh.mockClear(); apiMock.mockReset(); mockUser = null;
});

function mount() {
  let r: any;
  act(() => { r = TestRenderer.create(React.createElement(UnverifiedBanner)); });
  return r;
}

describe('UnverifiedBanner', () => {
  it('renders for an unverified user', () => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    expect(has(mount(), 'unverified-banner')).toBe(true);
  });

  it('renders nothing for a verified user', () => {
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: true };
    expect(has(mount(), 'unverified-banner')).toBe(false);
  });

  it('renders nothing when email_verified is undefined (legacy / OAuth)', () => {
    mockUser = { id: 'u1', email: 'a@gmail.com' };
    expect(has(mount(), 'unverified-banner')).toBe(false);
  });

  it('resend hits the resend-verification endpoint', async () => {
    apiMock.mockResolvedValue({ message: 'Verification email sent' });
    mockUser = { id: 'u1', email: 'a@gmail.com', email_verified: false };
    const r = mount();
    await act(async () => { await node(r, 'unverified-resend').props.onPress(); });
    expect(apiMock).toHaveBeenCalledWith('/auth/resend-verification', { method: 'POST' });
  });
});
