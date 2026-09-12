const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { resolve } = require('node:path');

(async () => {
  const browser = await chromium.launch({ headless: true, channel: process.env.SCHEMA_QA_BROWSER_CHANNEL || undefined });
  try {
    for (const width of [1366, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 844 } });
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.goto(pathToFileURL(resolve(process.argv[2])).href);
      if (await page.locator('#side').isVisible()) await page.locator('#closeSide').click();
      await page.locator('#tab-map').click();
      await page.locator('#zoomIn').click();
      await page.locator('#zoomIn').click();
      const stage = page.locator('#stage');
      const bounds = await stage.boundingBox();
      const start = { x: bounds.x + bounds.width * 0.6, y: bounds.y + bounds.height * 0.6 };
      const before = await stage.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
      await page.mouse.move(start.x, start.y);
      await page.mouse.down();
      await page.mouse.move(start.x - 120, start.y - 90, { steps: 10 });
      await page.mouse.up();
      const after = await stage.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
      assert.ok(after.x > before.x + 100 && after.y > before.y + 70, JSON.stringify({ width, before, after }));
      assert.equal(await page.locator('#side').isVisible(), false, 'Dragging must not open the inspector');
      const node = page.locator('.graph-node').first();
      await node.scrollIntoViewIfNeeded();
      const box = await node.boundingBox();
      const nodeStart = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const nodeBefore = await stage.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
      await page.mouse.move(nodeStart.x, nodeStart.y);
      await page.mouse.down();
      await page.mouse.move(nodeStart.x - 75, nodeStart.y - 60, { steps: 10 });
      await page.mouse.up();
      const nodeAfter = await stage.evaluate(el => ({ x: el.scrollLeft, y: el.scrollTop }));
      assert.ok(nodeAfter.x > nodeBefore.x + 50 || nodeAfter.y > nodeBefore.y + 40, 'Node-start drag must pan');
      assert.equal(await page.locator('#side').isVisible(), false);
      await node.click();
      assert.equal(await page.locator('#side').isVisible(), true, 'A normal click must still inspect');
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ width, pan: true, nodeDrag: true, click: true }));
      await page.close();
    }
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
