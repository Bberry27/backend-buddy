// Run with CITY_BROWSER_MODULES set to a directory containing playwright and pngjs.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const external = name => require(process.env.CITY_BROWSER_MODULES ? join(process.env.CITY_BROWSER_MODULES, name) : name);
const { chromium } = external('playwright');
const { PNG } = external('pngjs');
const result = await build({ stdin: { contents: `
  import React from 'react';
  import { createRoot } from 'react-dom/client';
  import City from './City';
  const tables = Array.from({length: 42}, (_, i) => ({id: 'table_' + i,
    name: i === 0 ? 'long_table_name_with_many_words_that_must_fit_in_the_hover_label' : 'Table ' + i,
    className: 'Table' + i, domain: ['Operations', 'Billing', 'Fleet', 'Identity'][i % 4], type: 'table',
    pk: 'id', indexes: [], uniques: [], rowCount: i % 4 === 0 ? undefined : i === 1 ? 0 : i ** 4,
    allColumns: Array.from({length: 4 + (i * 7) % 28}, (_, j) => ({name:'col_' + j, type:'integer',
      pk:j === 0, fk:'', nullable:'False', index:false, unique:false}))}));
  const graph = {tables, links: tables.slice(1).map((t, i) => ({source:t.id, target:tables[i].id,
    column:'parent_id', targetColumn:'id', kind:i % 2 ? 'declared FK' : 'inferred by naming'}))};
  createRoot(document.getElementById('root')).render(<City graph={graph}
    onSelectTable={id => document.getElementById('selection').textContent = id} />);
`, resolveDir: directory, loader: 'tsx' }, bundle: true, write: false, outdir: 'city-memory',
  format: 'iife', jsx: 'automatic', define: { 'process.env.NODE_ENV': '"production"' } });
const js = result.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = result.outputFiles.find(file => file.path.endsWith('.css')).text;
const html = `<!doctype html><html><head><style>
  html,body,#root{margin:0;width:100%;height:100%;overflow:hidden}body{font-family:Arial,sans-serif}
  #selection{display:none}
  ${css}</style></head><body><div id="root"></div><output id="selection"></output><script src="/city.js"></script></body></html>`;
const server = createServer((request, response) => {
  response.setHeader('Content-Type', request.url === '/city.js' ? 'text/javascript' : 'text/html');
  response.end(request.url === '/city.js' ? js : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
let browser;
function colorfulPixels(buffer) {
  const { data } = PNG.sync.read(buffer);
  let count = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (Math.max(data[i], data[i + 1], data[i + 2]) - Math.min(data[i], data[i + 1], data[i + 2]) > 35) count++;
  }
  return count;
}
try {
  browser = await chromium.launch({ headless: true, channel: process.env.CITY_BROWSER_CHANNEL || undefined,
    args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') console.error(message.text()); });
  await page.goto(url);
  const canvas = page.locator('canvas');
  await canvas.waitFor({ timeout: 15000 }).catch(async error => {
    console.error(await page.locator('body').innerText(), errors);
    throw error;
  });
  await page.waitForFunction(() => document.querySelector('canvas')?.width > 100);
  // Allow the first rendered frame, including instanced transforms, to settle.
  await page.waitForTimeout(600);
  const initial = await canvas.screenshot();
  assert.ok(colorfulPixels(initial) > 5000, '3D city must contain visible colored geometry');
  const box = await canvas.boundingBox();
  const rendered = PNG.sync.read(initial);
  let target;
  for (let y = 0; y < rendered.height && !target; y += 5) for (let x = 0; x < rendered.width; x += 5) {
    const offset = (y * rendered.width + x) * 4;
    const channels = [...rendered.data.subarray(offset, offset + 3)];
    if (Math.max(...channels) > 150 && Math.max(...channels) - Math.min(...channels) > 45) { target = { x, y }; break; }
  }
  assert.ok(target, 'A building surface must be available to hit-test');
  await page.mouse.move(box.x + target.x, box.y + target.y);
  await page.locator('.schema-city-tooltip').waitFor();
  await page.mouse.click(box.x + target.x, box.y + target.y);
  assert.match(await page.locator('#selection').textContent(), /^table_/, '3D click must select the hit table');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.6, { steps: 12 });
  await page.mouse.up();
  assert.notDeepEqual(await canvas.screenshot(), initial, 'Orbit must change the rendered frame');
  await page.getByRole('button', { name: 'Fit city', exact: true }).click();
  assert.ok(colorfulPixels(await canvas.screenshot()) > 5000);
  if (process.env.CITY_QA_SCREENSHOTS) await page.screenshot({ path: join(directory, 'city-qa-desktop.png') });
  await page.getByRole('button', { name: 'Flat map', exact: true }).click();
  const targets = page.locator('.schema-city-target');
  assert.equal(await targets.count(), 42);
  await targets.first().focus();
  await page.keyboard.press('Enter');
  assert.match(await page.locator('#selection').textContent(), /^table_/);
  await page.getByRole('button', { name: 'Table 1 · 0 rows', exact: false }).focus();
  assert.match(await page.locator('.schema-city-tooltip').textContent(), /0 rows/);
  await page.keyboard.press('Space');
  assert.equal(await page.locator('#selection').textContent(), 'table_1');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: '3D city', exact: true }).click();
  await canvas.waitFor();
  await page.waitForTimeout(250);
  assert.ok(colorfulPixels(await canvas.screenshot()) > 800, 'Mobile camera must frame visible geometry');
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  if (process.env.CITY_QA_SCREENSHOTS) await page.screenshot({ path: join(directory, 'city-qa-mobile.png') });
  await canvas.evaluate(element => element.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
  await page.getByText('WebGL unavailable · Flat map active').waitFor();
  assert.equal(await targets.count(), 42);
  assert.equal(await page.getByRole('button', { name: '3D city', exact: true }).isDisabled(), true);
  await targets.first().focus();
  await page.keyboard.press('Enter');
  assert.match(await page.locator('#selection').textContent(), /^table_/);
  assert.deepEqual(errors, []);

  const failedPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await failedPage.addInitScript(() => {
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function(type, ...args) {
      if (String(type).startsWith('webgl')) return null;
      return getContext.call(this, type, ...args);
    };
  });
  await failedPage.goto(url);
  await failedPage.getByText('WebGL unavailable · Flat map active').waitFor();
  assert.equal(await failedPage.locator('.schema-city-target').count(), 42);
  console.log('City browser QA passed: software WebGL pixels, 3D hover/click, orbit, fit, mobile, keyboard selection, context loss, and unavailable WebGL.');
} finally {
  await browser?.close();
  await new Promise(resolve => server.close(resolve));
}
