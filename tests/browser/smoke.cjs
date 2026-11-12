// Browser check for the built page. Optional: needs Playwright and Chrome.
//   npm run build && npm run test:browser
// It drives dist/index.html with the keyboard, checks mobile layout, and fails
// if the page makes any network request or writes to browser storage.
const path = require('node:path');
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const file = 'file://' + path.join(__dirname, '..', '..', 'dist', 'index.html');
const shots = path.join(__dirname, 'screenshots');
const results = [];
const check = async (name, fn) => {
  try { await fn(); results.push(['PASS', name]); }
  catch (err) { results.push(['FAIL', name + ' :: ' + String(err.message).split('\n')[0]]); }
};

async function tabTo(page, selector, max = 80) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await page.evaluate((sel) => document.activeElement === document.querySelector(sel), selector)) return;
  }
  throw new Error(`could not reach ${selector} with Tab`);
}

(async () => {
  fs.mkdirSync(shots, { recursive: true });
  const launch = process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel: 'chrome' };
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await ctx.newPage();
  const requests = [];
  const errors = [];
  page.on('request', (r) => { if (!r.url().startsWith('file://') || !r.url().endsWith('dist/index.html')) requests.push(r.url()); });
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(file);
  await check('landing page shows the headline and both buttons', async () => {
    assert.equal(await page.textContent('h1'), 'Can you rescue this customer implementation?');
    assert.equal(await page.textContent('#start-challenge'), 'Try the 60-second challenge');
    assert.equal(await page.textContent('#start-explore'), 'Explore the system');
    assert.ok(await page.locator('svg.map').count() >= 1);
  });
  await page.screenshot({ path: path.join(shots, 'home-desktop.png'), fullPage: true });

  await check('keyboard only: complete the challenge and reach the comparison', async () => {
    await tabTo(page, '#start-challenge');
    await page.keyboard.press('Enter');
    assert.match(await page.textContent('h1'), /Duplicate integration event/);
    await tabTo(page, '#coach-next'); await page.keyboard.press('Enter');
    assert.ok(await page.locator('#sec-evidence').count());
    await tabTo(page, '#coach-next'); await page.keyboard.press('Enter');
    await tabTo(page, '#opt-key'); await page.keyboard.press('Space');
    assert.ok(await page.isChecked('#opt-key'));
    await tabTo(page, '#run-fix'); await page.keyboard.press('Enter');
    assert.ok(await page.evaluate(() => document.activeElement && document.activeElement.id === 'compare-title'), 'focus moves to the comparison');
    const text = await page.textContent('.panel-compare');
    assert.match(text, /Service targets met: 1 of 4 in the baseline, 4 of 4 with your fix/);
    assert.match(text, /Duplicate tasks created.*?2.*?0/s);
    assert.match(text, /18 of 18 reconciliation checks pass/);
  });
  await page.screenshot({ path: path.join(shots, 'challenge-compare-desktop.png'), fullPage: true });

  await check('keyboard: replay slider and step buttons move the cursor', async () => {
    const before = await page.textContent('.position');
    await page.focus('#replay-slider'); await page.keyboard.press('ArrowRight');
    const after = await page.textContent('.position');
    assert.notEqual(before, after);
    await page.focus('#replay-next'); await page.keyboard.press('Enter');
    assert.notEqual(after, await page.textContent('.position'));
  });

  await check('reset clears the revised run and returns to step 1', async () => {
    await page.focus('#reset-top'); await page.keyboard.press('Enter');
    assert.equal(await page.locator('#compare-title').count(), 0);
    assert.match(await page.textContent('.coach'), /Step 1 of 4/);
    assert.match(await page.textContent('#sec-replay'), /Replay: baseline/);
  });

  await check('same seed and fix give the same fingerprints twice', async () => {
    const runOnce = async () => {
      await page.click('#reset-top');
      await page.click('#coach-next'); await page.click('#coach-next');
      await page.check('#opt-key'); await page.click('#run-fix');
      return page.$$eval('.panel-compare .small .mono', (els) => els.map((e) => e.textContent).join(','));
    };
    const a = await runOnce();
    const b = await runOnce();
    assert.ok(/^[0-9a-f]{8},[0-9a-f]{8}$/.test(a), a);
    assert.equal(a, b);
  });

  await check('explore: rule editor refuses out-of-range values with a reason', async () => {
    await page.evaluate(() => { location.hash = 'explore'; });
    await page.waitForSelector('#rule-dedupe-windowMin');
    await page.selectOption('#rule-dedupe-mode', 'window');
    await page.fill('#rule-dedupe-windowMin', '999');
    await page.click('#run-fix');
    assert.match(await page.textContent('#rule-dedupe-windowMin-issues'), /between 1 and 240/);
    assert.match(await page.textContent('#run-message'), /has errors/);
    assert.equal(await page.locator('#compare-title').count(), 0);
    await page.fill('#rule-dedupe-windowMin', '30');
    await page.click('#run-fix');
    const text = await page.textContent('.panel-compare');
    assert.match(text, /Distinct requests wrongly suppressed.*?0.*?1/s);
  });

  await check('explore: running the unchanged baseline is refused with a message', async () => {
    await page.click('#reset-top');
    await page.click('#run-fix');
    assert.match(await page.textContent('#run-message'), /is the baseline/);
  });

  await check('explore: seed input rejects bad values and loads good ones', async () => {
    await page.fill('#seed-input', 'abc'); await page.keyboard.press('Enter');
    assert.match(await page.textContent('#seed-error'), /whole number from 1 to 999999/);
    await page.fill('#seed-input', '42'); await page.keyboard.press('Enter');
    assert.equal(await page.textContent('#seed-error'), '');
    assert.equal(await page.inputValue('#seed-input'), '42');
  });

  await check('scenario B: auto-approve is shown as rejected, and the task is not released', async () => {
    await page.click('.scenario-bar .seg-btn:nth-child(2)');
    await page.check('#opt-auto'); await page.click('#run-fix');
    const text = await page.textContent('.panel-compare');
    assert.match(text, /Transitions rejected.*?0.*?1/s);
    assert.match(text, /guard G-APPROVAL/);
    assert.match(text, /Work starts only after an authorized approver decides/);
  });
  await page.screenshot({ path: path.join(shots, 'explore-b-auto-desktop.png'), fullPage: true });

  await check('scenario C: both responses run and show a comparison', async () => {
    await page.click('.scenario-bar .seg-btn:nth-child(3)');
    for (const id of ['#opt-flag', '#opt-overflow']) {
      await page.check(id); await page.click('#run-fix');
      assert.match(await page.textContent('.panel-compare'), /Blocked time nobody could see/);
    }
  });

  await check('inside the project renders the generated tables and the recorded test result', async () => {
    await page.evaluate(() => { location.hash = 'inside'; });
    await page.waitForSelector('#in-states');
    assert.match(await page.textContent('.inside'), /8 states and 18 allowed transitions/);
    assert.match(await page.textContent('.verified'), /\d+ of \d+ tests passed, 0 failed/);
  });

  await check('mobile 375px: no page-level horizontal scroll on any view', async () => {
    await page.setViewportSize({ width: 375, height: 740 });
    for (const hash of ['', 'challenge', 'explore', 'inside']) {
      await page.evaluate((x) => { location.hash = x; }, hash);
      await page.waitForTimeout(150);
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(over <= 0, `view "${hash || 'home'}" overflows by ${over}px`);
      await page.screenshot({ path: path.join(shots, `mobile-${hash || 'home'}.png`), fullPage: true });
    }
    await page.evaluate(() => { location.hash = 'explore'; });
    await page.waitForSelector('#opt-key');
    await page.check('#opt-key'); await page.click('#run-fix');
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(over <= 0, `comparison overflows by ${over}px`);
    const small = await page.$$eval('button, select, input[type=text]', (els) => els.filter((e) => e.offsetParent && e.getBoundingClientRect().height < 34).map((e) => e.id || e.textContent.slice(0, 20)));
    assert.deepEqual(small, [], 'controls under 34px tall: ' + small.join(' | '));
    await page.screenshot({ path: path.join(shots, 'mobile-explore-compare.png'), fullPage: true });
  });

  await check('reduced motion: no autoplay control, replay jumps instead', async () => {
    const p2 = await (await browser.newContext({ reducedMotion: 'reduce', viewport: { width: 1280, height: 900 } })).newPage();
    await p2.goto(file + '#challenge');
    assert.equal(await p2.textContent('#replay-play'), 'Go to end');
    await p2.click('#replay-play');
    assert.match(await p2.textContent('.position'), /Event (\d+) of \1/);
    await p2.context().close();
  });

  await check('dark theme renders', async () => {
    const p3 = await (await browser.newContext({ colorScheme: 'dark', viewport: { width: 1280, height: 900 } })).newPage();
    await p3.goto(file + '#challenge');
    const bg = await p3.evaluate(() => getComputedStyle(document.body).backgroundColor);
    assert.equal(bg, 'rgb(17, 19, 26)');
    await p3.screenshot({ path: path.join(shots, 'challenge-dark.png'), fullPage: true });
    await p3.context().close();
  });

  await check('no network requests, no storage writes, no cookies, no console errors', async () => {
    assert.deepEqual(requests, []);
    const stored = await page.evaluate(() => ({ ls: localStorage.length, ss: sessionStorage.length, cookie: document.cookie }));
    assert.deepEqual(stored, { ls: 0, ss: 0, cookie: '' });
    assert.deepEqual(errors, []);
  });

  await browser.close();
  for (const [status, name] of results) console.log(status, name);
  const failed = results.filter((r) => r[0] === 'FAIL').length;
  console.log(`\n${results.length - failed} of ${results.length} browser checks passed.`);
  process.exit(failed ? 1 : 0);
})().catch((err) => { console.error(err); process.exit(1); });
