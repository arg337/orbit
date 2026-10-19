'use strict';
// Run: node test/browser.js  (needs playwright; starts mock Groq + dev server itself)
const { spawn } = require('child_process');
const path = require('path');
const startMock = require('./mock-groq');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const OUT = process.env.SHOTS || '/tmp/orbit-shots';
require('fs').mkdirSync(OUT, { recursive: true });

(async () => {
  const mock = await startMock(4201);
  const srv = spawn('node', ['dev-server.js'], { cwd: path.join(__dirname, '..'), env: { ...process.env, PORT: '4200', GROQ_API_KEY: 'test-key-not-real', GROQ_API_URL: 'http://127.0.0.1:4201/x', GROQ_MODEL: 'mock-model' } });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch({ executablePath: process.env.CHROME || undefined });
  const results = [];
  const check = (name, ok, extra) => { results.push(ok); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
  try {
    for (const [w, h] of [[375, 812], [430, 932], [768, 1024], [1280, 800], [1440, 900]]) {
      const ctx = await browser.newContext({ viewport: { width: w, height: h }, reducedMotion: 'reduce' });
      const page = await ctx.newPage();
      await page.goto('http://localhost:4200');
      await page.waitForTimeout(300);
      const m = await page.evaluate(() => ({
        overflow: document.documentElement.scrollWidth - window.innerWidth,
        sceneBottom: document.querySelector('.scene').getBoundingClientRect().bottom,
        chatTop: document.querySelector('.chat').getBoundingClientRect().top,
        sceneRight: document.querySelector('.scene-col').getBoundingClientRect().right,
        chatLeft: document.querySelector('.chat').getBoundingClientRect().left,
        smallTargets: [...document.querySelectorAll('button, textarea')].filter((e) => e.offsetParent && e.getBoundingClientRect().height < 44).map((e) => e.id || e.className)
      }));
      check(`${w}px no horizontal scroll`, m.overflow <= 0, 'overflow ' + m.overflow);
      check(`${w}px layout`, w <= 620 ? m.chatTop >= m.sceneBottom - 1 : m.chatLeft > m.sceneRight, w <= 620 ? 'stacked' : 'side by side');
      check(`${w}px tap targets >= 44px`, m.smallTargets.length === 0, m.smallTargets.join(','));
      await page.screenshot({ path: `${OUT}/${w}-initial.png`, fullPage: true });
      await ctx.close();
    }

    // behaviour at 430 and desktop
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    await page.goto('http://localhost:4200');
    await page.keyboard.press('Tab');
    check('skip link first in tab order', await page.evaluate(() => document.activeElement.className === 'skip'));
    await page.click('#suggest button >> nth=2');
    await page.waitForSelector('.typing');
    check('loading indicator shown', true);
    await page.screenshot({ path: `${OUT}/loading.png` });
    await page.waitForSelector('.msg.bot:not(.typing) .letter');
    const reply = await page.textContent('.msg.bot .letter');
    check('real (mock) reply displayed + markdown', /Mock reply \(context: 1 messages, model: mock-model\)/.test(reply) && await page.locator('.letter ul li').count() === 2 && await page.locator('.letter pre').count() === 1);
    await page.fill('#composer-input', 'And a follow-up?');
    await page.keyboard.press('Enter');
    await page.waitForSelector('.msg.bot:nth-child(4):not(.typing) .letter');
    check('follow-up carries context', /context: 3 messages/.test(await page.textContent('.msg.bot:nth-child(4):not(.typing) .letter')));
    await page.screenshot({ path: `${OUT}/chat-desktop.png` });
    // shift+enter newline does not send
    await page.fill('#composer-input', 'a');
    await page.keyboard.press('Shift+Enter');
    check('shift+enter does not send', (await page.locator('.msg.user').count()) === 2);
    // errors
    await page.fill('#composer-input', '__500__'); await page.keyboard.press('Enter');
    await page.waitForSelector('.msg.error');
    check('error state with retry', await page.locator('.retry').count() === 1);
    await page.screenshot({ path: `${OUT}/error.png` });
    // theme toggle
    await page.click('#theme-toggle');
    check('tone toggle -> parchment + persisted', await page.evaluate(() => document.documentElement.dataset.theme === 'parchment' && localStorage.getItem('orbit-theme') === 'parchment'));
    await page.screenshot({ path: `${OUT}/parchment.png` });
    await page.reload();
    check('tone persists after reload', await page.evaluate(() => document.documentElement.dataset.theme === 'parchment'));
    // new chat
    await page.fill('#composer-input', 'hello'); await page.keyboard.press('Enter');
    await page.waitForSelector('.typing');
    await page.click('#new-chat');
    await page.waitForTimeout(1200);
    check('new chat resets (and ignores late reply)', await page.locator('.msg').count() === 0 && await page.locator('#suggest').count() === 1);
    // focus ring
    await page.focus('#new-chat'); await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Tab');
    check('focus ring is 2px sky', await page.evaluate(() => { const s = getComputedStyle(document.activeElement); return s.outlineWidth === '2px' && s.outlineColor === 'rgb(102, 155, 188)' && s.outlineOffset === '3px'; }));
    await ctx.close();

    // 375 conversation shot
    const mctx = await browser.newContext({ viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true });
    const mp = await mctx.newPage();
    await mp.goto('http://localhost:4200');
    await mp.click('#suggest button >> nth=0');
    await mp.waitForSelector('.msg.bot:not(.typing) .letter');
    check('375 no overflow after chat', await mp.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth));
    await mp.screenshot({ path: `${OUT}/375-chat.png`, fullPage: true });
    await mctx.close();
  } finally {
    await browser.close(); srv.kill(); mock.server.close();
  }
  console.log(results.every(Boolean) ? 'ALL PASS' : 'SOME FAILED');
})();
