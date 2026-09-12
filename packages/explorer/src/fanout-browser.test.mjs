import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

// Run directly; FANOUT_PLAYWRIGHT_MODULE can point to an existing Playwright installation.
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.FANOUT_PLAYWRIGHT_MODULE || 'playwright');
const directory = dirname(fileURLToPath(import.meta.url));
const css = await readFile(resolve(directory, 'Fanout.css'), 'utf8');
const result = await build({ stdin: { contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client'; import Fanout from './Fanout';
  const table = (id, rowCount) => ({id,rowCount,className:id,domain:'Operations',type:'table',pk:'id',primaryKey:['id'],allColumns:[],indexes:[],uniques:[]});
  const fk = (source,target) => ({source,target,column:'parent_id',targetColumn:'id',kind:'declared FK'});
  const graph = {tables:[table('accounts',10),table('bookings',40),table('charges',100),table('deliveries'),table('empty_table',0)],links:[fk('bookings','accounts'),fk('charges','accounts'),fk('deliveries','bookings'),fk('deliveries','charges'),fk('empty_table','accounts'),fk('accounts','deliveries')]};
  window.calls=[]; window.selected=[];
  const live={subtree:async(request,signal)=>{window.calls.push(request);await new Promise(resolve=>setTimeout(resolve,40));return {nodes:[{id:'r',tableId:request.rootTable,depth:0,rowCount:1},{id:'c',tableId:'bookings',depth:1,rowCount:2,truncated:true}],links:[{source:'r',target:'c',ratio:2,count:2}],truncated:true,limit:10000}}};
  const root=createRoot(document.getElementById('root')); window.show=(value=graph,connection=live)=>root.render(<Fanout graph={value} live={connection} onSelectTable={id=>window.selected.push(id)}/>);window.show();
`, resolveDir: directory, loader: 'tsx' }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' }, logLevel: 'silent' });
const browser = await chromium.launch({ channel: process.env.FANOUT_BROWSER_CHANNEL || 'msedge', headless: true });
const page = await browser.newPage();
const errors = [];
page.on('pageerror', error => errors.push(error.message));
try {
  await page.setViewportSize({ width: 1366, height: 768 });
  await page.setContent(`<style>:root{--bg:#101316;--panel:#1b2025;--raised:#272e34;--ink:#e6eaed;--muted:#a5b0ba;--line:#3b444c;--accent:#62c9b2}body{margin:0}#root{height:100dvh;width:100%}${css}</style><div id="root"></div>`);
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.locator('.fanout-node').first().waitFor();
  assert.equal(await page.locator('.fanout-node').count(), 5);
  assert.equal(await page.locator('.fanout-ratio-label').count(), 5);
  assert.equal(await page.getByText('Rows unknown', { exact: true }).count(), 1);
  await page.getByRole('button', { name: 'Collapse accounts at depth 0', exact: true }).click();
  assert.equal(await page.locator('.fanout-node').count(), 1);
  await page.getByRole('button', { name: 'Expand all branches' }).click();
  assert.equal(await page.locator('.fanout-node').count(), 5);
  await page.getByRole('button', { name: 'Inspect accounts, 10 rows', exact: true }).click();
  assert.deepEqual(await page.evaluate(() => window.selected), ['accounts']);
  for (const viewport of [{width:1366,height:768},{width:390,height:844},{width:390,height:420}]) {
    await page.setViewportSize(viewport);
    const bounds = await page.evaluate(() => ({ width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,invalid:[...document.querySelectorAll('path')].some(path=>/NaN|Infinity/.test(path.getAttribute('d')||'')) }));
    assert.ok(bounds.width <= viewport.width, JSON.stringify(bounds));
    assert.ok(bounds.height <= viewport.height, JSON.stringify(bounds));
    assert.equal(bounds.invalid,false);
    const overlaps = await page.locator('.fanout-node').evaluateAll(nodes=>nodes.some((node,index)=>nodes.slice(index+1).some(other=>{const a=node.getBoundingClientRect(),b=other.getBoundingClientRect();return a.left<b.right&&a.right>b.left&&a.top<b.bottom&&a.bottom>b.top})));
    assert.equal(overlaps,false);
    if (viewport.width === 390 && viewport.height === 844 && process.env.FANOUT_SCREENSHOT) await page.screenshot({path:process.env.FANOUT_SCREENSHOT.replace('.png','-mobile.png')});
  }
  await page.setViewportSize({width:1366,height:768});
  if (process.env.FANOUT_SCREENSHOT) await page.screenshot({path:process.env.FANOUT_SCREENSHOT});
  await page.getByRole('button',{name:'Start from one row',exact:true}).click();
  await page.getByRole('textbox',{name:'Root primary key value'}).fill('42');
  await page.getByRole('button',{name:'Load subtree',exact:true}).click();
  await page.getByText(/Live results are truncated/).waitFor();
  assert.deepEqual(await page.evaluate(()=>window.calls[0]),{rootTable:'accounts',pkValue:42,depth:2,maxRowsPerHop:10000});
  await page.getByRole('button',{name:'Load subtree',exact:true}).click();
  await page.getByLabel('Root table',{exact:true}).selectOption('bookings');
  await page.waitForTimeout(100);
  assert.equal(await page.locator('.fanout-node').count(),0);
  await page.evaluate(()=>window.show(undefined,null));
  await page.getByText('Start from one row unavailable: no live subtree connection.',{exact:true}).waitFor();
  assert.equal(await page.getByRole('button',{name:'Start from one row',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Table counts',exact:true}).click();
  await page.getByLabel('Root table',{exact:true}).selectOption('empty_table');
  assert.equal(await page.locator('.fanout-node').count(),1);
  assert.equal(await page.locator('.fanout-node').evaluate(node=>Number.isFinite(node.getBoundingClientRect().x)),true);
  await page.evaluate(()=>window.show({tables:[],links:[]},undefined));
  await page.getByText('No tables available.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('Fanout browser checks passed: desktop/mobile, finite layout, collapse/expand, selection, live request and truncation.');
} finally { await browser.close(); }
