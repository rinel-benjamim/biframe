import { _electron as electron } from 'playwright';
import path from 'node:path';
import fs from 'node:fs/promises';

const root = process.cwd();
const out = path.join(root, '.poc-out');
const profile = path.join(out, 'profile-dom');
await fs.rm(profile, { recursive: true, force: true });
await fs.mkdir(out, { recursive: true });
const app = await electron.launch({
  args: ['.'],
  cwd: root,
  env: { ...process.env, BIFRAME_USER_DATA_DIR: profile, BIFRAME_DISABLE_DEVTOOLS: '1' },
});
const page = await app.firstWindow();
await page.waitForSelector('.app', { timeout: 60_000 });
await page.waitForTimeout(1500);

const dump = await page.evaluate(() => {
  const rows = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    if (size >= 30 && el.textContent && el.children.length === 0) {
      const r = el.getBoundingClientRect();
      rows.push({ tag: el.tagName, cls: el.className, text: el.textContent.slice(0, 80), size, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], opacity: cs.opacity, color: cs.color });
    }
  }
  const lowOpacity = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const o = parseFloat(cs.opacity);
    if (o > 0 && o < 0.9) {
      const r = el.getBoundingClientRect();
      lowOpacity.push({ tag: el.tagName, cls: el.className, opacity: o, rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)], text: (el.textContent ?? '').slice(0, 40) });
    }
  }
  return { rows, lowOpacity: lowOpacity.slice(0, 40), bodyChildren: [...document.body.children].map((e) => e.tagName + '.' + e.className), html: document.documentElement.outerHTML.length };
});
console.log('big text', JSON.stringify(dump.rows, null, 2));
console.log('low opacity', JSON.stringify(dump.lowOpacity, null, 2));
console.log('body', dump.bodyChildren, 'html length', dump.html);

await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important}' });
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(out, 'diag-noanim.png') });
await app.close();
