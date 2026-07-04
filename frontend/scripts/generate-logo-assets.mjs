// TripSplitter logo asset generator.
//
// One source of truth for the brand mark (a "forking route" — a journey line that
// splits into two branches, each ending in a map-pin node) rendered in a fresh
// teal->green gradient. Produces every icon/splash/favicon PNG wired through
// app.json, plus editable master SVGs (assets/logo/*.svg) you can open in Figma.
//
// Run:  node scripts/generate-logo-assets.mjs   (needs `sharp`; `npm i -D sharp`)
//
// Design decisions live in the plan + CLAUDE-adjacent notes; keep filenames stable
// so app.json needs no changes.

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { Buffer } from 'node:buffer';
import sharp from 'sharp';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const IMAGES = join(ROOT, 'assets', 'images');
const LOGO = join(ROOT, 'assets', 'logo');
mkdirSync(LOGO, { recursive: true });

// ---- Palette -------------------------------------------------------------
const BG_TOP = '#0E1A16'; // dark tile top (subtle teal-tinted)
const BG_BOT = '#0A0D0C'; // app dark base
const G0 = '#0FBFA6'; // teal
const G1 = '#2FD39B';
const G2 = '#5CE07E'; // green
const WORD_LIGHT = '#F7F5F0';

// The mark lives in this tight viewBox (art bounds + a little margin).
const MARK_VB = '100 88 324 404';

// Gradient used by the stroke + nodes, in mark-viewBox coordinates.
function markGradDef(id) {
  return `<linearGradient id="${id}" gradientUnits="userSpaceOnUse" x1="120" y1="470" x2="400" y2="110">
      <stop offset="0" stop-color="${G0}"/>
      <stop offset="0.55" stop-color="${G1}"/>
      <stop offset="1" stop-color="${G2}"/>
    </linearGradient>`;
}

// The forking-route mark itself (paths only; expects gradient id `gid`).
function markPaths(gid) {
  return `<g fill="none" stroke="url(#${gid})" stroke-width="44" stroke-linecap="round" stroke-linejoin="round">
      <path d="M256,300 L256,452"/>
      <path d="M150,138 C208,150 250,236 256,300 C262,236 322,168 374,154"/>
    </g>
    <g fill="url(#${gid})">
      <circle cx="256" cy="452" r="24"/>
      <circle cx="150" cy="138" r="34"/>
      <circle cx="374" cy="154" r="34"/>
    </g>`;
}

// A nested <svg> that drops the mark into a square canvas at the given coverage
// (fraction of canvas height), centered horizontally, with an optional vertical bias.
function markBlock(canvas, coverage, gid, cy = 0.5) {
  const vbH = 404, vbW = 324;
  const h = Math.round(canvas * coverage);
  const w = Math.round((h * vbW) / vbH);
  const x = Math.round((canvas - w) / 2);
  const y = Math.round(canvas * cy - h / 2);
  return `<svg x="${x}" y="${y}" width="${w}" height="${h}" viewBox="${MARK_VB}" preserveAspectRatio="xMidYMid meet">${markPaths(gid)}</svg>`;
}

// ---- Composed SVGs -------------------------------------------------------

// Full-bleed dark tile + glow + mark (icon / favicon). Opaque.
function iconSVG(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${BG_TOP}"/><stop offset="1" stop-color="${BG_BOT}"/>
    </linearGradient>
    <radialGradient id="glow" cx="0.5" cy="0.52" r="0.5">
      <stop offset="0" stop-color="${G1}" stop-opacity="0.28"/>
      <stop offset="1" stop-color="${G1}" stop-opacity="0"/>
    </radialGradient>
    ${markGradDef('mg')}
  </defs>
  <rect width="1024" height="1024" fill="url(#tile)"/>
  <circle cx="512" cy="540" r="400" fill="url(#glow)"/>
  ${markBlock(1024, 0.66, 'mg', 0.5)}
</svg>`;
}

// Android adaptive foreground: mark only, transparent, inside the ~62% safe zone.
function adaptiveSVG(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 1024 1024">
  <defs>${markGradDef('mg')}</defs>
  ${markBlock(1024, 0.55, 'mg', 0.5)}
</svg>`;
}

// Splash lockup: mark above a two-tone "TripSplitter" wordmark, transparent.
function splashSVG(px) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 1200 1200">
  <defs>${markGradDef('mg')}</defs>
  <svg x="${(1200 - Math.round((520 * 324) / 404)) / 2}" y="200" width="${Math.round((520 * 324) / 404)}" height="520" viewBox="${MARK_VB}" preserveAspectRatio="xMidYMid meet">${markPaths('mg')}</svg>
  <text x="600" y="900" font-family="Arial, Helvetica, sans-serif" font-size="118" font-weight="700" text-anchor="middle" letter-spacing="-2">
    <tspan fill="${WORD_LIGHT}">Trip</tspan><tspan fill="${G1}">Splitter</tspan>
  </text>
</svg>`;
}

// Editable masters for Figma.
function masterMarkSVG() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="324" height="404" viewBox="${MARK_VB}">
  <defs>${markGradDef('mg')}</defs>
  ${markPaths('mg')}
</svg>`;
}
function masterLockupSVG() {
  return splashSVG(1200);
}

// ---- Render --------------------------------------------------------------
async function png(svg, out, { opaque = false } = {}) {
  let pipe = sharp(Buffer.from(svg));
  if (opaque) pipe = pipe.flatten({ background: BG_BOT });
  await pipe.png().toFile(out);
  console.log('wrote', out);
}

async function main() {
  // Master SVGs (Figma-importable)
  writeFileSync(join(LOGO, 'tripsplitter-logo.svg'), masterMarkSVG());
  writeFileSync(join(LOGO, 'tripsplitter-lockup.svg'), masterLockupSVG());
  console.log('wrote master SVGs in assets/logo/');

  // PNG assets (filenames must match app.json)
  await png(iconSVG(1024), join(IMAGES, 'icon.png'), { opaque: true });
  await png(adaptiveSVG(1024), join(IMAGES, 'adaptive-icon.png'));
  await png(iconSVG(512), join(IMAGES, 'favicon.png'), { opaque: true });
  await png(splashSVG(1200), join(IMAGES, 'splash-image.png'));

  // Remove the leftover, unreferenced scaffold splash duplicate (app-image.png).
  const stray = join(IMAGES, 'app-image.png');
  if (existsSync(stray)) {
    rmSync(stray);
    console.log('deleted', stray);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
