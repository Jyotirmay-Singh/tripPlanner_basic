import { captureEmailActionToken, clearEmailActionToken, readEmailActionToken } from '../emailActionToken';
jest.mock('react-native', () => ({ Platform: { OS: 'web' } }));

const replaceState = jest.fn();
function location(href: string) {
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    location: { href }, history: { replaceState },
  } });
}

beforeEach(() => {
  clearEmailActionToken('verify-email'); clearEmailActionToken('reset-password');
  replaceState.mockClear();
});

afterAll(() => { Reflect.deleteProperty(globalThis, 'window'); });

it('captures fragments in memory and removes them from history before rendering', () => {
  location('https://app.example.com/verify-email#token=secret-token');
  captureEmailActionToken();
  expect(replaceState).toHaveBeenCalledWith(null, '', '/verify-email');
  expect(readEmailActionToken('verify-email')).toBe('secret-token');
  expect(readEmailActionToken('reset-password')).toBe('');
  clearEmailActionToken('verify-email');
  expect(readEmailActionToken('verify-email')).toBe('');
});

it('scrubs legacy query tokens and preserves unrelated parameters', () => {
  location('https://app.example.com/reset-password?token=old&theme=dark');
  captureEmailActionToken();
  expect(replaceState).toHaveBeenCalledWith(null, '', '/reset-password?theme=dark');
  expect(readEmailActionToken('reset-password')).toBe('old');
});

it('ignores token-looking fragments on other pages', () => {
  location('https://app.example.com/dashboard#token=unrelated');
  captureEmailActionToken();
  expect(replaceState).not.toHaveBeenCalled();
  expect(readEmailActionToken('verify-email')).toBe('');
});
