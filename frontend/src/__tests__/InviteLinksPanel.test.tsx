/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';


const mockList = jest.fn();
const mockRevoke = jest.fn();

jest.mock('../api', () => ({
  listTripInvites: (...args: any[]) => mockList(...args),
  revokeTripInvite: (...args: any[]) => mockRevoke(...args),
}));
jest.mock('../ThemeContext', () => ({
  useTheme: () => ({ colors: {
    surfaceMuted: '#eee', primary: '#153', border: '#ccc', danger: '#c00',
    success: '#080', textMuted: '#555',
  } }),
}));
jest.mock('../T', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('T', props, props.children) };
});
jest.mock('../Badge', () => {
  const R = require('react');
  return { __esModule: true, default: (props: any) => R.createElement('Badge', props) };
});
jest.mock('../ConfirmModal', () => {
  const R = require('react');
  return {
    __esModule: true,
    default: (props: any) => props.visible ? R.createElement('ConfirmModal', props) : null,
  };
});
jest.mock('../ui', () => {
  const R = require('react');
  return {
    Button: (props: any) => R.createElement('Button', props),
    Card: (props: any) => R.createElement('Card', props, props.children),
    Icon: (props: any) => R.createElement('Icon', props),
  };
});

const InviteLinksPanel = require('../InviteLinksPanel').default;

const activeInvite = {
  id: 'invite-1', created_by: 'owner-1', created_at: '2026-09-04T10:00:00Z',
  expires_at: '2026-09-11T10:00:00Z', status: 'active', use_count: 0,
};

describe('InviteLinksPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockList.mockResolvedValue([activeInvite]);
    mockRevoke.mockResolvedValue({
      ...activeInvite, status: 'revoked', revoked_at: '2026-09-05T10:00:00Z',
    });
  });

  it('creates through the parent share flow and revokes an active link', async () => {
    const onCreateAndShare = jest.fn().mockResolvedValue(undefined);
    let renderer: any;
    await act(async () => {
      renderer = TestRenderer.create(
        <InviteLinksPanel tripId="trip-1" refreshKey={0} onCreateAndShare={onCreateAndShare} />,
      );
      await Promise.resolve();
    });

    await act(async () => {
      renderer.root.findByProps({ testID: 'invite-create-share' }).props.onPress();
      await Promise.resolve();
    });
    expect(onCreateAndShare).toHaveBeenCalledTimes(1);

    act(() => renderer.root.findByProps({ testID: 'invite-revoke-invite-1' }).props.onPress());
    const modal = renderer.root.findByType('ConfirmModal' as any);
    await act(async () => {
      modal.props.actions[0].onPress();
      await Promise.resolve();
    });

    expect(mockRevoke).toHaveBeenCalledWith('trip-1', 'invite-1');
    expect(renderer.root.findAllByProps({ testID: 'invite-revoke-invite-1' })).toHaveLength(0);
    expect(renderer.root.findAllByType('T' as any).some(
      (node: any) => typeof node.props.children === 'string'
        && node.props.children.startsWith('Revoked '),
    )).toBe(true);
  });
});
