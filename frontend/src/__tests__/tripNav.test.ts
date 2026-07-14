// Unit test for the pure trip header-back helper (src/tripNav.ts), mirroring authNav.test.ts:
// use the stack back when there IS history, else fall back to the Trips tab.
import { goBackOrTrips, TRIPS_TAB_HREF } from '../tripNav';

const makeRouter = (canGoBack?: () => boolean) => ({
  canGoBack,
  back: jest.fn(),
  replace: jest.fn(),
});

describe('goBackOrTrips', () => {
  it('uses the stack back when there is history', () => {
    const r = makeRouter(() => true);
    goBackOrTrips(r);
    expect(r.back).toHaveBeenCalledTimes(1);
    expect(r.replace).not.toHaveBeenCalled();
  });

  it('falls back to the Trips tab when there is no history', () => {
    const r = makeRouter(() => false);
    goBackOrTrips(r);
    expect(r.replace).toHaveBeenCalledWith(TRIPS_TAB_HREF);
    expect(r.back).not.toHaveBeenCalled();
  });

  it('falls back to the Trips tab when canGoBack is unavailable (treated as no history)', () => {
    const r = makeRouter(undefined);
    goBackOrTrips(r);
    expect(r.replace).toHaveBeenCalledWith(TRIPS_TAB_HREF);
    expect(r.back).not.toHaveBeenCalled();
  });
});
