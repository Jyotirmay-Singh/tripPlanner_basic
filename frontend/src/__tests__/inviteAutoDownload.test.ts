import {
  claimInviteApkAutoDownload,
  isAndroidWebBrowser,
} from '../inviteAutoDownload';


it('recognizes only an Android browser on the web landing page', () => {
  const android = 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140';
  expect(isAndroidWebBrowser('web', android)).toBe(true);
  expect(isAndroidWebBrowser('android', android)).toBe(false);
  expect(isAndroidWebBrowser('web', 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0)')).toBe(false);
  expect(isAndroidWebBrowser('web', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe(false);
});

it('claims an automatic download only once per token and browser session', () => {
  const values = new Map<string, string>();
  const storage = {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  };
  const firstToken = 'a'.repeat(43);
  const secondToken = 'b'.repeat(43);

  expect(claimInviteApkAutoDownload(firstToken, storage)).toBe(true);
  expect(claimInviteApkAutoDownload(firstToken, storage)).toBe(false);
  expect(claimInviteApkAutoDownload(secondToken, storage)).toBe(true);
  expect([...values.keys()].join(' ')).not.toContain(firstToken);
});

it('still prevents repeat attempts when session storage is blocked', () => {
  const token = 'c'.repeat(43);
  const blockedStorage = {
    getItem: () => { throw new Error('blocked'); },
    setItem: () => { throw new Error('blocked'); },
  };

  expect(claimInviteApkAutoDownload(token, blockedStorage)).toBe(true);
  expect(claimInviteApkAutoDownload(token, blockedStorage)).toBe(false);
});
