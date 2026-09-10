/* eslint-disable @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';


const mockGet = jest.fn();
const mockReset = jest.fn();
const mockSetString = jest.fn();
const mockToastShow = jest.fn();

jest.mock('expo-clipboard', () => ({ setStringAsync: (...args: any[]) => mockSetString(...args) }));
jest.mock('../api', () => ({
  getTripInviteLink: (...args: any[]) => mockGet(...args),
  resetTripInviteLink: (...args: any[]) => mockReset(...args),
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
    useToast: () => ({ show: mockToastShow }),
  };
});

const InviteLinksPanel = require('../InviteLinksPanel').default;
const url = `https://tripsplitter-web.vercel.app/invite/${'a'.repeat(43)}`;
const replacementUrl = `https://tripsplitter-web.vercel.app/invite/${'b'.repeat(43)}`;

async function mount(canReset = true, onShare = jest.fn().mockResolvedValue(undefined)) {
  let renderer: any;
  await act(async () => {
    renderer = TestRenderer.create(
      <InviteLinksPanel tripId="trip-1" canReset={canReset} onShare={onShare} />,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
  return { renderer, onShare };
}

describe('InviteLinksPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockGet.mockResolvedValue({ url });
    mockReset.mockResolvedValue({ url: replacementUrl });
    mockSetString.mockResolvedValue(undefined);
  });

  it('shows one URL and lets an admin copy, share, and reset it', async () => {
    const { renderer, onShare } = await mount();

    expect(mockGet).toHaveBeenCalledWith('trip-1');
    expect(renderer.root.findByProps({ testID: 'trip-invite-link-url' }).props.children).toBe(url);

    await act(async () => {
      renderer.root.findByProps({ testID: 'invite-copy-link' }).props.onPress();
      await Promise.resolve();
    });
    expect(mockSetString).toHaveBeenCalledWith(url);
    expect(mockToastShow).toHaveBeenCalledWith('Link copied.', 'success');

    await act(async () => {
      renderer.root.findByProps({ testID: 'invite-share-link' }).props.onPress();
      await Promise.resolve();
    });
    expect(onShare).toHaveBeenCalledWith(url);

    act(() => renderer.root.findByProps({ testID: 'invite-reset-link' }).props.onPress());
    const modal = renderer.root.findByType('ConfirmModal' as any);
    await act(async () => {
      modal.props.actions[0].onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(mockReset).toHaveBeenCalledWith('trip-1');
    expect(renderer.root.findByProps({ testID: 'trip-invite-link-url' }).props.children)
      .toBe(replacementUrl);
    expect(mockToastShow).toHaveBeenCalledWith('New trip link ready.', 'success');

    const visibleText = renderer.root.findAllByType('T' as any)
      .map((node: any) => node.props.children)
      .flat()
      .filter((value: any) => typeof value === 'string')
      .join(' ');
    expect(visibleText).not.toMatch(/Revoked|Expired|Expires|Created by|successful use/i);
  });

  it('lets a regular trip member copy and share without exposing reset', async () => {
    const { renderer } = await mount(false);

    expect(renderer.root.findByProps({ testID: 'invite-copy-link' })).toBeTruthy();
    expect(renderer.root.findByProps({ testID: 'invite-share-link' })).toBeTruthy();
    expect(renderer.root.findAllByProps({ testID: 'invite-reset-link' })).toHaveLength(0);
  });

  it('offers a retry when the link cannot be loaded', async () => {
    mockGet.mockRejectedValueOnce(new Error('Connection unavailable'));
    const { renderer } = await mount();

    expect(renderer.root.findByProps({ testID: 'trip-invite-link-error' })).toBeTruthy();
    mockGet.mockResolvedValue({ url });
    await act(async () => {
      renderer.root.findByProps({ label: 'Try again' }).props.onPress();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(renderer.root.findByProps({ testID: 'trip-invite-link-url' }).props.children).toBe(url);
  });
});
