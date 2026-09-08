/* global Buffer, __dirname, describe, expect, it */

const fs = require('fs');
const path = require('path');
const sharp = require('sharp');


describe('Android notification icon configuration', () => {
  it('resolves the branded monochrome TS asset and existing channel settings', async () => {
    const config = require('../../app.config.js');
    const plugin = config.expo.plugins.find(
      (entry) => Array.isArray(entry) && entry[0] === 'expo-notifications',
    );

    expect(plugin).toBeDefined();
    expect(plugin[1]).toEqual(expect.objectContaining({
      color: '#1FC89A',
      defaultChannel: 'trip_activity',
    }));

    const resolvedIcon = fs.readFileSync(plugin[1].icon);
    const encodedIcon = Buffer.from(
      fs.readFileSync(path.join(__dirname, '../../assets/images/notification-icon.base64'), 'utf8')
        .trim(),
      'base64',
    );
    expect(resolvedIcon.equals(encodedIcon)).toBe(true);

    const metadata = await sharp(resolvedIcon).metadata();
    expect(metadata).toEqual(expect.objectContaining({
      width: 96,
      height: 96,
      hasAlpha: true,
    }));

    const { data, info } = await sharp(resolvedIcon)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    let transparentPixels = 0;
    let visiblePixels = 0;
    let nonWhiteVisiblePixels = 0;
    for (let offset = 0; offset < data.length; offset += info.channels) {
      const alpha = data[offset + 3];
      if (alpha === 0) {
        transparentPixels += 1;
        continue;
      }
      visiblePixels += 1;
      if (data[offset] !== 255 || data[offset + 1] !== 255 || data[offset + 2] !== 255) {
        nonWhiteVisiblePixels += 1;
      }
    }
    expect(transparentPixels).toBeGreaterThan(0);
    expect(visiblePixels).toBeGreaterThan(0);
    expect(nonWhiteVisiblePixels).toBe(0);
  });
});
