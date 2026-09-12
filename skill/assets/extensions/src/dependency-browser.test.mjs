// Run with DEPENDENCY_BROWSER_MODULES pointing to playwright and pngjs packages.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const directory = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const external = name => require(process.env.DEPENDENCY_BROWSER_MODULES ? join(process.env.DEPENDENCY_BROWSER_MODULES, name) : name);
const { chromium } = external('playwright');
const { PNG } = external('pngjs');
const bundle = await build({ stdin: { contents: `
  import React from 'react';
  import {createRoot} from 'react-dom/client';
  import JoinMatrix from './JoinMatrix';
  import ArcDiagram from './ArcDiagram';
  const query = new URLSearchParams(location.search), count = Number(query.get('count') || 12);
  const id = i => 'table_' + String(i).padStart(3, '0');
  const tables = Array.from({length:count}, (_,i) => ({id:id(i), name:id(i), className:id(i), domain:'Core',
    type:'table', pk:'id', indexes:[], uniques:[], allColumns:[], schema:i%2?'app':'audit', rowCount:i%5?i*100:undefined}));
  const fk = (a,b,extra={}) => ({source:id(a),target:id(b),column:'parent_id',targetColumn:'id',kind:'declared FK',
    constraintId:'fk_' + a + '_' + b,cardinality:'one-to-many',onDelete:'CASCADE',...extra});
  const links = count > 4 ? [
    ...Array.from({length:count-2}, (_,i) => fk(i+1,i)),
    fk(1,0,{column:'tenant_id',targetColumn:'tenant_id'}),
    fk(1,0,{column:'approver_id',constraintId:'fk_approver',cardinality:'one-to-one'}),
    fk(2,3),fk(4,4),
  ] : [];
  const Component = query.get('view') === 'arc' ? ArcDiagram : JoinMatrix;
  createRoot(document.getElementById('root')).render(<Component graph={{tables,links}}
    onSelectTable={id=>document.getElementById('selection').textContent=id}
    onSelectTables={query.has('pair') ? ids=>document.getElementById('selection').textContent=ids.join(',') : undefined} />);
`, loader: 'tsx', resolveDir: directory }, bundle: true, write: false, outdir: 'dependency-memory', jsx: 'automatic',
  format: 'iife', define: { 'process.env.NODE_ENV': '"production"' } });
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).text;
const html = `<!doctype html><html><head><style>html,body,#root{width:100%;height:100%;margin:0;overflow:hidden}body{font-family:Arial,sans-serif}#selection{display:none}${css}</style></head><body><div id="root"></div><output id="selection"></output><script src="/dependency.js"></script></body></html>`;
const server = createServer((request, response) => {
  const script = request.url === '/dependency.js';
  response.setHeader('Content-Type', script ? 'text/javascript' : 'text/html'); response.end(script ? js : html);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launch({ headless: true, channel: process.env.DEPENDENCY_BROWSER_CHANNEL || undefined });
  const page = await browser.newPage({ viewport: { width: 1366, height: 768 } });
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto(`${base}/?pair`);
  const grid = page.getByRole('grid');
  await grid.waitFor();
  assert.equal(await page.locator('.schema-matrix-surface svg').count(), 1);
  await grid.focus(); await page.keyboard.press('ArrowDown');
  await page.getByRole('tooltip').filter({ hasText: 'fk_approver' }).waitFor();
  assert.match(await page.getByRole('tooltip').textContent(), /tenant_id/);
  assert.match(await page.getByRole('tooltip').textContent(), /ON DELETE CASCADE/);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#selection').textContent(), 'table_001,table_000');
  assert.equal(await page.locator('.schema-matrix-surface svg text').filter({ hasText: /^2$/ }).count(), 1);
  await page.getByLabel('Table order', { exact: true }).selectOption('rcm');
  await page.getByLabel('Related only', { exact: true }).check();
  assert.equal(await grid.getAttribute('aria-rowcount'), '11');
  if (process.env.DEPENDENCY_QA_SCREENSHOTS) await page.screenshot({ path: join(directory, 'dependency-qa-matrix.png') });

  await page.goto(`${base}/?count=140`);
  const canvas = page.locator('.schema-matrix-surface canvas');
  await canvas.waitFor();
  const dimensions = await canvas.evaluate(element => ({ width: element.width, height: element.height }));
  assert.ok(dimensions.width <= 1366 * 2 && dimensions.height <= 768 * 2, 'Canvas must be viewport-sized');
  await grid.focus(); await page.keyboard.press('Control+End'); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#selection').textContent(), 'table_139');
  assert.ok(await grid.evaluate(element => element.scrollLeft > 0 && element.scrollTop > 0));
  await page.getByLabel('Table order', { exact: true }).selectOption('rowcount');
  await grid.focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('#selection').textContent(), 'table_139');
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.evaluate(() => document.documentElement.style.setProperty('--bg', '#ffffff'));
  await page.waitForTimeout(80);
  const pixels = PNG.sync.read(await canvas.screenshot());
  const offset = ((Math.min(pixels.height - 1, 136)) * pixels.width + Math.min(pixels.width - 1, 169)) * 4;
  assert.ok(pixels.data[offset] > 200, 'Canvas must redraw for a host theme change');
  if (process.env.DEPENDENCY_QA_SCREENSHOTS) await page.screenshot({ path: join(directory, 'dependency-qa-canvas-mobile.png') });

  await page.setViewportSize({ width: 1366, height: 768 });
  await page.goto(`${base}/?view=arc&pair`);
  const panel = page.getByRole('complementary', { name: 'Strongly connected cycle groups' });
  await panel.waitFor();
  assert.equal(await panel.locator('.schema-arc-cycle-group').count(), 2);
  await panel.getByText('Contains self-reference').waitFor();
  const arc = page.locator('.schema-arc-edge').filter({ has: page.locator('title', { hasText: 'fk_1_0:' }) });
  await arc.focus();
  await page.getByRole('tooltip').filter({ hasText: 'tenant_id' }).waitFor();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#selection').textContent(), 'table_001,table_000');
  await page.getByRole('button', { name: 'table_011; isolated table', exact: true }).focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#selection').textContent(), 'table_011');
  if (process.env.DEPENDENCY_QA_SCREENSHOTS) await page.screenshot({ path: join(directory, 'dependency-qa-arc.png') });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.getByRole('button', { name: 'Hide cycle groups', exact: true }).click();
  assert.equal(await panel.count(), 0);
  await page.getByRole('button', { name: 'Show cycle groups', exact: true }).click();
  await panel.getByRole('button', { name: 'table_004', exact: true }).click();
  assert.equal(await page.locator('#selection').textContent(), 'table_004');
  if (process.env.DEPENDENCY_QA_SCREENSHOTS) await page.screenshot({ path: join(directory, 'dependency-qa-arc-mobile.png') });
  await page.goto(`${base}/?count=0`);
  await page.getByText('No tables in this schema.', { exact: true }).waitFor();
  await page.goto(`${base}/?view=arc&count=0`);
  await page.getByText('No tables in this schema.', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  console.log('Dependency browser QA passed: SVG/canvas threshold, composite counts, arrow navigation, pair/fallback selection, ordering, related-only filter, viewport canvas, theme refresh, cycles, and mobile/empty layouts.');
} finally {
  await browser?.close(); await new Promise(resolve => server.close(resolve));
}
