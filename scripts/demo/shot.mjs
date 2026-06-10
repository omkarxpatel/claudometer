// Renders the demo dashboard (scripts/demo/out/index.html, built by gen.ts)
// and captures the README screenshots. Run from the repo root:
//
//   npx esbuild scripts/demo/gen.ts --bundle --platform=node --format=cjs \
//     --outfile=scripts/demo/out/gen.cjs && node scripts/demo/out/gen.cjs
//   node scripts/demo/shot.mjs
//
// Requires playwright + chromium (npm i -D playwright && npx playwright install chromium).
import path from 'path';
import { chromium } from 'playwright';

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1240, height: 940 },
  deviceScaleFactor: 2,
});
await page.goto('file://' + path.resolve('scripts/demo/out/index.html'));
await page.waitForTimeout(500);
await page.screenshot({ path: 'media/screenshots/overview.png', fullPage: true });

await page.click('button[data-tab="projects"]');
await page.waitForTimeout(150);
await page.click('tr.proj-row');
await page.waitForTimeout(250);
const height = await page.evaluate(
  () => document.querySelector('main').getBoundingClientRect().bottom + 24
);
await page.setViewportSize({ width: 1240, height: Math.ceil(height) });
await page.screenshot({ path: 'media/screenshots/projects.png' });

await browser.close();
console.log('screenshots written to media/screenshots/');
