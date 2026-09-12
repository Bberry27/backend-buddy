const {chromium} = require('playwright');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const {pathToFileURL} = require('node:url');

(async () => {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error('Usage: node check_explorer.cjs <html> <qa-directory>');
  await fs.mkdir(output, {recursive:true});
  const browser = await chromium.launch({headless:true, ...(process.env.RELATIONAL_MAP_BROWSER_CHANNEL ? {channel:process.env.RELATIONAL_MAP_BROWSER_CHANNEL} : {})});
  try {
    const page = await browser.newPage({viewport:{width:1920,height:1080}});
    const errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.goto(pathToFileURL(path.resolve(input)).href);
    await page.waitForTimeout(300);
    const counts=await page.evaluate(()=>{const d=JSON.parse(document.getElementById('schema-data').textContent);return {tables:d.tables.length,keys:d.tables.reduce((n,t)=>n+t.allColumns.filter(c=>c.pk||c.fk||c.name.endsWith('_id')).length,0)};});
    assert.equal(await page.locator('.graph-node').count(),counts.tables);
    for(const theme of ['light','dark']) {
      await page.locator('#theme').selectOption(theme);
      await page.reload();
      assert.equal(await page.locator('html').getAttribute('data-theme'),theme);
      await page.screenshot({path:path.join(output,`desktop-${theme}.png`)});
    }
    for(const [width,height] of [[1920,1080],[1366,768],[390,844]]) {
      await page.setViewportSize({width,height});
      if(width<700 && await page.locator('#side').isVisible()) await page.locator('#closeSide').click();
      for(const tab of ['map','entities','keys','review']) {
        await page.locator('#tab-'+tab).click();
        await page.waitForTimeout(150);
        const size=await page.evaluate(()=>({w:document.documentElement.scrollWidth,h:document.documentElement.scrollHeight}));
        assert.deepEqual(size,{w:width,h:height});
        await page.screenshot({path:path.join(output,`${width}-${tab}.png`)});
      }
    }
    await page.setViewportSize({width:1366,height:768});
    await page.locator('#tab-entities').click();
    assert.equal(await page.locator('tr[data-row]').count(),counts.tables);
    await page.locator('#search').fill('definitely_no_matching_schema_entity');
    assert.equal(await page.locator('tr[data-row]').count(),0);
    await page.locator('#reset').click();
    if(counts.tables>=2){await page.locator('[data-compare]').nth(0).check();await page.locator('[data-compare]').nth(1).check();await page.locator('#compare').click();assert(await page.locator('#comparison').isVisible());}
    await page.locator('#tab-keys').click();
    assert.equal(await page.locator('tr[data-row]').count(),counts.keys);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({passed:true,...counts,screenshots:path.resolve(output)}));
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
