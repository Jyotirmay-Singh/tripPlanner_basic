// Brand asset generator — keeps the S/T symbol independent of the
// Splitora wordmark, so changing the name never changes app icons or splash art.
//
// The source is a single flattened tile holding two visual elements:
//   • the SYMBOL  — location pin + dashed route + "S/T" monogram
//   • the WORDMARK — "Splitora" text along the bottom
// The lossless source-symbol.png is the current textless symbol tile.
// The wordmark from source-app-logo.jpg (keyed to transparent) is used on the
// sign-in screens. Supersedes the old procedural generate-logo-assets.mjs.
//
// Run:  node scripts/crop-brand-assets.mjs        (needs `sharp`; already a devDep)
// Add --symbol-only to preserve the existing wordmark bytes when editing the symbol.
//
// The source tile is 1254 square; the wordmark band includes the lowercase p's descender.

import { fileURLToPath } from 'node:url';
import { writeFile, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC = join(ROOT, 'assets', 'logo', 'source-app-logo.jpg');
const SYMBOL = join(ROOT, 'assets', 'logo', 'source-symbol.png');
const IMAGES = join(ROOT, 'assets', 'images');

const DARK = '#0A0D0C'; // app dark base (matches android.adaptiveIcon.backgroundColor)

const WORDMARK = { left: 225, top: 988, width: 830, height: 100 };

async function symbolTile() {
  return sharp(SYMBOL).png().toBuffer();
}

async function writePng(buf, name, msg) {
  const temporary = join(IMAGES, `.${name}.${process.pid}.tmp`);
  try {
    await writeFile(temporary, await sharp(buf).png().toBuffer());
    await rename(temporary, join(IMAGES, name));
  } finally {
    await unlink(temporary).catch(() => {});
  }
  console.log('wrote', name, msg || '');
}

async function main() {
  const tile = await symbolTile();

  // App icon + web favicon — full-bleed opaque square symbol tile.
  await writePng(
    await sharp(tile).resize(1024, 1024).flatten({ background: DARK }).toBuffer(),
    'icon.png', '(1024² opaque)',
  );
  await writePng(
    await sharp(tile).resize(512, 512).flatten({ background: DARK }).toBuffer(),
    'favicon.png', '(512² opaque)',
  );

  // Splash — same symbol tile (expo-splash-screen `contain` over the dark bg).
  await writePng(
    await sharp(tile).resize(1200, 1200).flatten({ background: DARK }).toBuffer(),
    'splash-image.png', '(1200² opaque)',
  );

  // Android adaptive foreground — mark inset in the ~80% safe zone on the dark bg,
  // so aggressive launcher masks (circle/squircle) never clip the pin/route.
  const inset = Math.round(1024 * 0.8);
  const insetTile = await sharp(tile).resize(inset, inset).toBuffer();
  await writePng(
    await sharp({ create: { width: 1024, height: 1024, channels: 4, background: DARK } })
      .composite([{ input: insetTile, gravity: 'center' }])
      .png()
      .toBuffer(),
    'adaptive-icon.png', '(1024², mark inset on dark)',
  );

  // Login wordmark — crop + luminance→alpha key so the dark card drops out and the
  // orange/teal letters read on BOTH light and dark sign-in backgrounds.
  if (process.argv.includes('--symbol-only')) return;
  const { data, info } = await sharp(SRC)
    .extract(WORDMARK)
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const ch = info.channels; // 4 (RGBA)
  const LO = 50, HI = 150;
  for (let i = 0; i < data.length; i += ch) {
    const mx = Math.max(data[i], data[i + 1], data[i + 2]);
    let t = (mx - LO) / (HI - LO);
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    data[i + 3] = Math.round(t * t * (3 - 2 * t) * 255); // smoothstep alpha
  }
  await writePng(
    await sharp(data, { raw: { width: info.width, height: info.height, channels: ch } }).png().toBuffer(),
    'wordmark.png', '(transparent wordmark for login)',
  );
}

main().catch((e) => { console.error(e); process.exit(1); });
