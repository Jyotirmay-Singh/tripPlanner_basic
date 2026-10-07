import React from 'react';
import Renderer, { act, type ReactTestRenderer } from 'react-test-renderer';
import useFinancialRefresh from '../useFinancialRefresh';
import { publishFinancialChange } from '../financialRefresh';
function Listener({ account, refresh }: { account: string; refresh: () => void }) {
  useFinancialRefresh(account, 'trip', refresh); return null;
}
test('coalesces all financial events for matching screens and suppresses the previous account', async () => {
  jest.useFakeTimers(); const expense = jest.fn(), balances = jest.fn(), stranger = jest.fn();
  let tree!: ReactTestRenderer;
  await act(async () => { tree = Renderer.create(<><Listener account="payer" refresh={expense} /><Listener account="payer" refresh={balances} /><Listener account="other" refresh={stranger} /></>); });
  await act(async () => {
    for (const reason of ['mutation', 'uncertain_outcome', 'upi_return', 'notification_tap', 'foreground']) publishFinancialChange({ accountId: 'payer', tripId: 'trip', reason });
    jest.advanceTimersByTime(200);
  });
  expect(expense).toHaveBeenCalledTimes(1); expect(balances).toHaveBeenCalledTimes(1); expect(stranger).not.toHaveBeenCalled();
  await act(async () => { tree.update(<Listener account="other" refresh={stranger} />); publishFinancialChange({ accountId: 'payer', tripId: 'trip', reason: 'mutation' }); jest.advanceTimersByTime(200); });
  expect(stranger).not.toHaveBeenCalled();
  await act(async () => tree.unmount()); jest.useRealTimers();
});
