/* eslint-disable import/first, @typescript-eslint/no-require-imports */
// jest.mock calls must precede the module imports they replace, and their factories use require();
// both are idiomatic for jest and intentionally exempted here.
import React from 'react';
import TestRenderer, { act } from 'react-test-renderer';

// Component test for the shared ToastProvider (src/ui/Toast.tsx): the additive ✕ close button
// renders inside an active toast and pressing it removes the notification immediately, separate
// from the auto-dismiss timer. We override only Animated.timing/spring so the exit animation's
// end callback (which calls setToast(null)) runs synchronously, making dismissal deterministic.
jest.mock('react-native', () => {
  const RN = jest.requireActual('react-native');
  // Animated.parallel feeds each child's start callback a { finished } result, so the stub must
  // pass it through; firing synchronously makes the entrance/exit animations resolve immediately.
  const sync = () => ({ start: (cb?: (r: { finished: boolean }) => void) => cb && cb({ finished: true }) });
  RN.Animated.timing = sync;
  RN.Animated.spring = sync;
  return RN;
});
jest.mock('react-native-safe-area-context', () => ({
  useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));
jest.mock('../../ThemeContext', () => ({
  useTheme: () => ({
    colors: {
      surface: '#fff', border: '#ccc', textMain: '#111', textMuted: '#888',
      success: '#0a0', danger: '#a00', primary: '#00a',
    },
  }),
}));
jest.mock('../../T', () => {
  const R = require('react');
  const { Text } = require('react-native');
  return { __esModule: true, default: (p: any) => R.createElement(Text, null, p.children) };
});
jest.mock('../../ui/Icon', () => {
  const R = require('react');
  return { __esModule: true, default: (p: any) => R.createElement('Icon', p) };
});
jest.mock('../../ui/IconButton', () => {
  const R = require('react');
  return { __esModule: true, default: (p: any) => R.createElement('IconButton', p) };
});

import { ToastProvider, useToast, ToastType } from '../../ui/Toast';

// Match only host nodes (string type) so a mocked function-component + the host element it
// returns — both carrying the spread testID — count once, like the unverified-banner test.
const findAllTestID = (r: any, id: string) =>
  r.root.findAll((n: any) => typeof n.type === 'string' && n.props && n.props.testID === id);
const hasTestID = (r: any, id: string) => findAllTestID(r, id).length > 0;
const hasText = (r: any, text: string) =>
  r.root.findAll((n: any) => n.props && n.props.children === text).length > 0;

// Fires show() once on mount so a toast is active for the assertions.
function Harness({ msg, type }: { msg: string; type: ToastType }) {
  const { show } = useToast();
  React.useEffect(() => { show(msg, type); }, [show, msg, type]);
  return null;
}

// Fake timers so show()'s auto-dismiss setTimeout is queued but never fires during/after a test
// (the Animated stub above already resolves animations synchronously, so nothing else needs them).
beforeEach(() => { jest.useFakeTimers(); });
afterEach(() => { jest.clearAllTimers(); jest.useRealTimers(); });

function mount(msg = 'Saved', type: ToastType = 'success') {
  let r: any;
  act(() => {
    r = TestRenderer.create(
      React.createElement(ToastProvider, null, React.createElement(Harness, { msg, type })),
    );
  });
  return r;
}

describe('Toast manual dismiss', () => {
  it('renders a labelled ✕ close button inside an active toast', () => {
    const r = mount('Expense added', 'success');
    expect(hasText(r, 'Expense added')).toBe(true);
    const btns = findAllTestID(r, 'toast-dismiss');
    expect(btns.length).toBe(1);
    expect(btns[0].props.accessibilityLabel).toBe('Dismiss notification');
    expect(btns[0].props.name).toBe('close');
  });

  it('pressing ✕ removes the active notification immediately', () => {
    const r = mount('Invalid credentials', 'error');
    expect(hasText(r, 'Invalid credentials')).toBe(true);

    act(() => { findAllTestID(r, 'toast-dismiss')[0].props.onPress(); });

    expect(hasTestID(r, 'toast-dismiss')).toBe(false);
    expect(hasText(r, 'Invalid credentials')).toBe(false);
  });
});
