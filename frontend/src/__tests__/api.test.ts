/* eslint-disable @typescript-eslint/no-require-imports */

jest.mock('@react-native-async-storage/async-storage', () => ({
  __esModule: true,
  default: {
    getItem: jest.fn().mockResolvedValue(null),
    setItem: jest.fn().mockResolvedValue(undefined),
    removeItem: jest.fn().mockResolvedValue(undefined),
  },
}));

const originalBackendUrl = process.env.EXPO_PUBLIC_BACKEND_URL;

afterEach(() => {
  if (originalBackendUrl == null) delete process.env.EXPO_PUBLIC_BACKEND_URL;
  else process.env.EXPO_PUBLIC_BACKEND_URL = originalBackendUrl;
  jest.restoreAllMocks();
  jest.resetModules();
});

it('preserves a missing endpoint as a non-transport configuration error', async () => {
  delete process.env.EXPO_PUBLIC_BACKEND_URL;
  jest.resetModules();
  const { api, ApiError } = require('../api');
  const fetchSpy = jest.spyOn(globalThis, 'fetch');

  await expect(api('/meta/config', { auth: false })).rejects.toMatchObject({
    name: 'ApiError',
    code: 'configuration',
  });
  await expect(api('/meta/config', { auth: false })).rejects.toBeInstanceOf(ApiError);
  expect(fetchSpy).not.toHaveBeenCalled();
});

it('preserves HTTP status and classifies an actual fetch rejection as network failure', async () => {
  process.env.EXPO_PUBLIC_BACKEND_URL = 'https://api.example.test/';
  jest.resetModules();
  const { api } = require('../api');
  const fetchSpy = jest.spyOn(globalThis, 'fetch');
  fetchSpy.mockResolvedValueOnce({
    ok: false,
    status: 403,
    text: () => Promise.resolve(JSON.stringify({ detail: 'Not a member' })),
  } as Response);

  await expect(api('/trips/t1/chat/messages')).rejects.toMatchObject({
    code: 'http',
    status: 403,
    message: 'Not a member',
  });

  fetchSpy.mockRejectedValueOnce(new TypeError('connection failed'));
  await expect(api('/trips/t1/chat/messages')).rejects.toMatchObject({
    code: 'network',
    message: 'Could not reach the server',
  });
});

it('surfaces structured backend conversion details', async () => {
  process.env.EXPO_PUBLIC_BACKEND_URL = 'https://api.example.test';
  jest.resetModules();
  const { api } = require('../api');
  jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: false,
    status: 503,
    text: () => Promise.resolve(JSON.stringify({
      detail: {
        code: 'exchange_rate_timeout',
        message: 'Exchange-rate provider timed out',
        retryable: true,
      },
    })),
  } as Response);

  await expect(api('/exchange-rates/quote')).rejects.toMatchObject({
    message: 'Exchange-rate provider timed out',
    detailCode: 'exchange_rate_timeout',
    retryable: true,
  });
});

it('distinguishes caller cancellation from a timeout', async () => {
  process.env.EXPO_PUBLIC_BACKEND_URL = 'https://api.example.test';
  jest.resetModules();
  const { api } = require('../api');
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockImplementationOnce((_url, init) => (
    new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
        return;
      }
      init?.signal?.addEventListener('abort', () => {
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' }));
      });
    })
  ));
  const controller = new AbortController();
  const request = api('/exchange-rates/quote', { signal: controller.signal, timeoutMs: 10_000 });
  controller.abort();

  await expect(request).rejects.toMatchObject({ code: 'aborted', message: 'The request was cancelled' });
  expect(fetchSpy).toHaveBeenCalledTimes(1);
});

it('builds quote requests entirely through the backend API', async () => {
  process.env.EXPO_PUBLIC_BACKEND_URL = 'https://api.example.test';
  jest.resetModules();
  const { quoteExchangeRate } = require('../api');
  const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
    ok: true,
    status: 200,
    text: () => Promise.resolve('{}'),
  } as Response);

  await quoteExchangeRate({
    from: 'INR', to: 'LKR', amount: '1000', date: '2026-08-28', mode: 'automatic',
  });

  expect(fetchSpy.mock.calls[0][0]).toBe(
    'https://api.example.test/api/exchange-rates/quote?from=INR&to=LKR&amount=1000&mode=automatic&date=2026-08-28',
  );
  expect(String(fetchSpy.mock.calls[0][0])).not.toContain('frankfurter.dev');
});
