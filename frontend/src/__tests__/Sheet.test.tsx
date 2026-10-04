/* eslint-disable import/first, @typescript-eslint/no-require-imports */
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { AccessibilityInfo, Animated, Modal, Platform, StyleSheet } from 'react-native';
jest.mock('../ThemeContext', () => ({ useTheme: () => ({ colors: new Proxy({}, { get: () => '#123456' }) }) }));
jest.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => ({ top: 24, bottom: 18, left: 0, right: 0 }) }));
jest.mock('../ui/Icon', () => ({ __esModule: true, default: () => null }));
jest.mock('../ui/IconButton', () => ({ __esModule: true, default: (p: any) => require('react').createElement('IconButton', p) }));
jest.mock('../T', () => ({ __esModule: true, default: (p: any) => require('react').createElement('T', p, p.children) }));
jest.mock('../api', () => ({ getPaymentRecipientDetails: jest.fn().mockResolvedValue({ recipients: [] }) }));
jest.mock('../upiLauncher', () => ({ discoverUpiApps: jest.fn().mockResolvedValue({ status: 'unsupported', apps: [] }) }));
jest.mock('../ui', () => {
  const R = require('react'); const stub = (n: string) => (p: any) => R.createElement(n, p, p.children);
  return { Sheet: require('../ui/Sheet').default, AmountText: stub('AmountText'), Button: stub('Button'), Card: stub('Card'), Icon: stub('Icon'), Input: stub('Input') };
});
import Sheet from '../ui/Sheet';
import CurrencyPicker from '../ui/CurrencyPicker';
import UpiPaymentSheet from '../UpiPaymentSheet';
import { deferred } from './fixtures/fixedCategoryGroups';

const mounted: any[] = [];
let motionListener: (value: boolean) => void;
let remove: jest.Mock;
let start: jest.Mock;
let stop: jest.Mock;
beforeEach(() => {
  remove = jest.fn(); start = jest.fn(); stop = jest.fn();
  jest.spyOn(AccessibilityInfo, 'isReduceMotionEnabled').mockResolvedValue(false);
  jest.spyOn(AccessibilityInfo, 'addEventListener').mockImplementation((_event: any, cb: any) => { motionListener = cb; return { remove } as any; });
  jest.spyOn(Animated, 'parallel').mockReturnValue({ start, stop, reset: jest.fn() });
  jest.spyOn(Animated, 'timing').mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
  jest.spyOn(Animated, 'spring').mockReturnValue({ start: jest.fn(), stop: jest.fn(), reset: jest.fn() });
});
afterEach(() => { act(() => mounted.splice(0).forEach((r) => r.unmount())); jest.restoreAllMocks(); });
async function mount(element: React.ReactElement) { let r: any; await act(async () => { r = TestRenderer.create(element); }); mounted.push(r); return r; }
const interactive = (r: any, id: string) => r.root.findAll((n: any) => n.props.testID === id && typeof n.props.onPress === 'function')[0];

it('retains payment defaults, independent hardware Back, safe-area spacing and normal animation', async () => {
  const close = jest.fn(); const back = jest.fn();
  const r = await mount(<Sheet visible title="Payment" testID="shared-sheet" closeTestID="close" scrimTestID="scrim" onClose={close} onRequestClose={back}><></></Sheet>);
  expect(r.root.findByType(Modal).props).toMatchObject({ transparent: true, animationType: 'none', statusBarTranslucent: true, navigationBarTranslucent: true });
  act(() => r.root.findByType(Modal).props.onRequestClose()); expect(back).toHaveBeenCalledTimes(1); expect(close).not.toHaveBeenCalled();
  act(() => interactive(r, 'scrim').props.onPress());
  act(() => r.root.findByType('IconButton' as any).props.onPress()); expect(close).toHaveBeenCalledTimes(2);
  expect(r.root.findByType('IconButton' as any).props).toMatchObject({ accessibilityLabel: 'Close payment sheet', reducedMotion: false });
  expect(r.root.findByType('IconButton' as any).props.touchSize).toBeUndefined();
  expect(Animated.spring).toHaveBeenCalled(); expect(start).toHaveBeenCalled();
  const surface = r.root.findAll((n: any) => n.props.testID === 'shared-sheet').at(-1);
  expect(StyleSheet.flatten(surface.props.style).paddingBottom).toBeGreaterThan(18);
});

it('uses immediate restrained motion, responds to preference changes and cleans listeners/animations', async () => {
  (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockResolvedValue(true);
  const r = await mount(<Sheet visible title="Category" restrainedMotion touchSize={48} closeLabel="Close category chooser" onClose={jest.fn()}><></></Sheet>);
  expect(Animated.parallel).not.toHaveBeenCalled();
  expect(r.root.findByType('IconButton' as any).props).toMatchObject({ touchSize: 48, reducedMotion: true, accessibilityLabel: 'Close category chooser' });
  act(() => motionListener(false));
  expect(Animated.timing).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ toValue: 0, duration: 180 }));
  expect(Animated.spring).not.toHaveBeenCalled(); expect(start).toHaveBeenCalledTimes(1);
  act(() => motionListener(true)); expect(stop).toHaveBeenCalledTimes(1);
  act(() => r.unmount()); mounted.splice(mounted.indexOf(r), 1); expect(remove).toHaveBeenCalledTimes(1);
});

it('ignores a reduced-motion query that resolves after unmount', async () => {
  const query = deferred<boolean>(); (AccessibilityInfo.isReduceMotionEnabled as jest.Mock).mockReturnValue(query.promise);
  const r = await mount(<Sheet visible restrainedMotion onClose={jest.fn()}><></></Sheet>);
  act(() => r.unmount()); mounted.splice(mounted.indexOf(r), 1);
  await act(async () => query.resolve(false)); expect(remove).toHaveBeenCalledTimes(1); expect(start).not.toHaveBeenCalled();
});

it('keeps real currency selection/cancellation compatible with shared-sheet defaults', async () => {
  const choose = jest.fn(); const r = await mount(<CurrencyPicker value="INR" onChange={choose} testID="currency" />);
  act(() => interactive(r, 'currency-trigger').props.onPress());
  expect(r.root.findByType(Modal).props.visible).toBe(true);
  expect(r.root.findByType(Sheet).props.trapFocus).toBeUndefined();
  act(() => interactive(r, 'currency-row-USD').props.onPress()); expect(choose).toHaveBeenCalledWith('USD');
  expect(r.root.findByType(Modal).props.visible).toBe(false);
  act(() => interactive(r, 'currency-trigger').props.onPress());
  act(() => r.root.findByType(Modal).props.onRequestClose()); expect(choose).toHaveBeenCalledTimes(1);
});

it('renders the real payment consumer with the same close/back behavior and no financial mutation', async () => {
  const close = jest.fn();
  const r = await mount(<UpiPaymentSheet visible tripId="t1" tripName="Group" fromMemberId="payer" fromName="Payer" toMemberId="recipient" toName="Recipient" initialAmount={100} currency="INR" wholeUnit onClose={close} />);
  expect(r.root.findByType(Sheet).props).toMatchObject({ title: 'Pay via UPI', testID: 'upi-payment-sheet', closeTestID: 'upi-sheet-close', scrimTestID: 'upi-sheet-scrim' });
  expect(r.root.findByType('IconButton' as any).props.accessibilityLabel).toBe('Close payment sheet');
  act(() => r.root.findByType(Modal).props.onRequestClose());
  act(() => interactive(r, 'upi-sheet-scrim').props.onPress()); expect(close).toHaveBeenCalledTimes(2);
  expect(require('../api').getPaymentRecipientDetails).toHaveBeenCalledWith('t1', 'payer', 'recipient');
});

it('cleans the web focus trap, wraps Tab/Shift+Tab, closes Escape and restores prior focus', async () => {
  const originalOS = Platform.OS; const prior = jest.fn(); const first = jest.fn(); const last = jest.fn(); const close = jest.fn();
  const firstControl = { focus: first, getAttribute: () => null }; const lastControl = { focus: last, getAttribute: () => null };
  let keydown!: (event: any) => void;
  const doc = { activeElement: { focus: prior }, querySelector: jest.fn(() => ({ querySelectorAll: () => [firstControl, lastControl] })),
    addEventListener: jest.fn((_key, cb) => { keydown = cb; }), removeEventListener: jest.fn() };
  const previousDocument = (globalThis as any).document;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' }); (globalThis as any).document = doc;
  try {
    const r = await mount(<Sheet visible trapFocus testID="focus-sheet" onClose={close}><></></Sheet>);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 1)); }); expect(first).toHaveBeenCalled();
    const event = (key: string, shiftKey = false) => ({ key, shiftKey, preventDefault: jest.fn(), stopPropagation: jest.fn() });
    (doc as any).activeElement = lastControl; const tab = event('Tab'); act(() => keydown(tab)); expect(tab.preventDefault).toHaveBeenCalled();
    (doc as any).activeElement = firstControl; const backTab = event('Tab', true); act(() => keydown(backTab)); expect(last).toHaveBeenCalled();
    const escape = event('Escape'); act(() => keydown(escape)); expect(close).toHaveBeenCalledTimes(1);
    act(() => r.unmount()); mounted.splice(mounted.indexOf(r), 1); expect(doc.removeEventListener).toHaveBeenCalledWith('keydown', keydown, true); expect(prior).toHaveBeenCalledTimes(1);
  } finally { Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS }); (globalThis as any).document = previousDocument; }
});
