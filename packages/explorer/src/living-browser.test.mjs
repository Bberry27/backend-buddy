// Run directly; LIVING_PLAYWRIGHT_MODULE may point to an existing Playwright installation.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.LIVING_PLAYWRIGHT_MODULE || 'playwright');
const directory = dirname(fileURLToPath(import.meta.url));
const result = await build({ stdin: { contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client'; import LivingERD from './LivingERD';
  const col = (name, pk=false) => ({name,type:'integer',pk,fk:'',nullable:'False',index:false,unique:false,profiling:{sampleValues:[1,2,3,4]}});
  const table = (id, rowCount) => ({id,rowCount,name:id,className:id,domain:id==='isolated'?'Finance':'Operations',type:'table',pk:'id',primaryKey:['id'],allColumns:[col('id',true),col('name')],indexes:[],uniques:[]});
  const fk=(source,target,column='parent_id')=>({source,target,column,targetColumn:'id',kind:'declared FK'});
  const graph={project:{key:'living-browser',name:'Browser fixture',dialect:'postgres'},source:{hash:'snapshot-a'},tables:[table('accounts',10),table('bookings',40),table('isolated'),{...table('account_bookings'),primaryKey:['account_id','booking_id'],allColumns:[col('account_id'),col('booking_id')]}],links:[fk('bookings','accounts'),fk('account_bookings','accounts','account_id'),fk('account_bookings','bookings','booking_id')]};
  window.fixture=graph; window.selected=[];const root=createRoot(document.getElementById('root'));window.show=(value=graph)=>root.render(<LivingERD graph={value} onSelectTable={id=>window.selected.push(id)}/>);window.show();
`, resolveDir: directory, loader: 'tsx' }, bundle: true, write: false, format: 'iife', outfile: 'living-qa.js', logLevel: 'silent' });
const js = result.outputFiles.find(file => file.path.endsWith('.js')).text;
const css = result.outputFiles.find(file => file.path.endsWith('.css')).text;
const pageHtml = `<style>:root{--bg:#101316;--panel:#1b2025;--raised:#272e34;--ink:#e6eaed;--muted:#a5b0ba;--line:#3b444c;--accent:#62c9b2}body{margin:0}#root{height:100dvh;width:100%}${css}</style><div id="root"></div><script>${js.replaceAll('</script','<\\/script')}</script>`;
const server = createServer((req,res) => {res.writeHead(200, {'Content-Type':'text/html'});res.end(pageHtml);});
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const browser = await chromium.launch({channel: process.env.LIVING_BROWSER_CHANNEL || 'msedge',headless:true});
const page = await browser.newPage({acceptDownloads:true,viewport:{width:1366,height:768}});
const errors=[];page.on('pageerror',e=>errors.push(e.message));
const requests=[];page.on('request',request=>requests.push(request.url()));
const url=`http://127.0.0.1:${server.address().port}`;
const search = async text => { await page.getByRole('textbox',{name:'Search tables'}).fill(text);await page.getByRole('textbox',{name:'Search tables'}).press('Enter');await page.waitForTimeout(500); };
try {
  await page.goto(url);await page.locator('.lerd-table').first().waitFor();await page.waitForTimeout(350);
  assert.equal(await page.locator('.lerd-table').count(),3);
  assert.equal(await page.locator('.react-flow__edge-path').count(),2);
  assert.equal(await page.locator('.react-flow__edge-path[marker-start][marker-end]').count(),2);
  assert.equal(await page.getByText(/1 junctions collapsed/).count(),1);
  assert.ok(await page.locator('.lerd-table').evaluateAll(nodes=>nodes.some(node=>{const r=node.getBoundingClientRect();return r.width>20&&r.height>10&&r.right>0&&r.left<innerWidth&&r.bottom>0&&r.top<innerHeight})), 'nonblank first render');
  assert.equal(await page.getByText('Rows unknown',{exact:true}).count(),1);
  await page.getByLabel('Show junctions').check();assert.equal(await page.locator('.lerd-table').count(),4);
  await page.getByLabel('Show junctions').uncheck();assert.equal(await page.locator('.lerd-table').count(),3);
  await search('accounts');assert.equal(await page.locator('.lerd-columns').count(),3);
  assert.equal(await page.locator('.lerd-samples').first().locator('code').count(),3);
  assert.deepEqual(await page.evaluate(()=>window.selected),['accounts']);
  const account=page.locator('.react-flow__node[data-id="accounts"]');
  await account.hover();assert.equal(await page.locator('.lerd-table.lerd-dimmed').count(),1);
  const header=account.locator('.lerd-table-title'),bounds=await header.boundingBox();
  await page.mouse.move(bounds.x+25,bounds.y+15);await page.mouse.down();await page.mouse.move(bounds.x+105,bounds.y+85,{steps:8});await page.mouse.up();
  await page.waitForTimeout(200);
  await page.getByRole('button',{name:'Unpin accounts',exact:true}).waitFor({timeout:3000});
  const saved=await page.evaluate(()=>JSON.parse(localStorage.getItem(Object.keys(localStorage).find(key=>key.startsWith('living-erd:')))));
  assert.equal(saved.positions.accounts.pinned,true);
  await page.reload();await page.locator('.lerd-table').first().waitFor();await search('accounts');
  await page.getByRole('button',{name:'Unpin accounts',exact:true}).waitFor();
  const restored=await account.evaluate(node=>{const matrix=new DOMMatrix(getComputedStyle(node).transform);return {x:matrix.m41,y:matrix.m42}});
  assert.ok(Math.abs(restored.x-saved.positions.accounts.x)<0.01&&Math.abs(restored.y-saved.positions.accounts.y)<0.01,JSON.stringify(restored));
  await page.evaluate(()=>window.show({...window.fixture,source:{hash:'snapshot-b'}}));await page.locator('.lerd-table').first().waitFor();await search('accounts');
  assert.equal(await page.getByRole('button',{name:'Pin accounts',exact:true}).count(),1);
  await page.evaluate(()=>window.show(window.fixture));await page.locator('.lerd-table').first().waitFor();await search('accounts');
  assert.equal(await page.getByRole('button',{name:'Unpin accounts',exact:true}).count(),1);
  for(let i=0;i<7;i++){await page.getByRole('button',{name:'Zoom out',exact:true}).click();await page.waitForTimeout(230);}
  assert.ok(await page.locator('.lerd-domain').count()>0);
  await page.locator('.lerd-domain').first().click();await page.waitForTimeout(400);
  assert.equal(await page.locator('.lerd-domain').count(),0);assert.equal(await page.locator('.lerd-columns').count(),0);
  await search('account_bookings');assert.equal(await page.locator('.lerd-table').count(),4);
  await page.getByRole('button',{name:'Fit diagram',exact:true}).click();await page.waitForTimeout(350);
  for (const size of [{width:1366,height:768},{width:390,height:844},{width:390,height:420}]) {
    await page.setViewportSize(size);await page.waitForTimeout(200);
    const bounds=await page.evaluate(()=>({width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight,canvas:document.querySelector('.lerd-canvas').getBoundingClientRect().height,invalid:[...document.querySelectorAll('path')].some(p=>/NaN|Infinity/.test(p.getAttribute('d')||''))}));
    assert.ok(bounds.width<=size.width&&bounds.height<=size.height,JSON.stringify(bounds));assert.ok(bounds.canvas>150);assert.equal(bounds.invalid,false);
    const clusterBounds=await page.locator('.lerd-domain').evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().toJSON()));
    for(const cluster of clusterBounds)assert.ok(cluster.left>=-1&&cluster.right<=size.width+1,JSON.stringify(cluster));
    if(process.env.LIVING_SCREENSHOT&&size.height!==420)await page.screenshot({path:process.env.LIVING_SCREENSHOT.replace('.png',size.width<500?'-mobile.png':'.png')});
  }
  await page.setViewportSize({width:1366,height:768});await page.getByRole('button',{name:'Fit diagram',exact:true}).click();await page.waitForTimeout(400);
  const exportedLabel=await page.locator('.lerd-domain strong,.lerd-table-title strong').first().textContent();
  for (const format of ['SVG','PNG']) {
    const pending=page.waitForEvent('download');await page.getByRole('button',{name:`Export ${format}`,exact:true}).click();const download=await pending;
    assert.equal(await download.failure(),null);const bytes=await readFile(await download.path());assert.ok(bytes.length>1000);
    if(format==='SVG'){assert.ok(bytes.toString().includes(exportedLabel),'SVG contains the currently visible table or domain label');assert.match(bytes.toString(),/<svg/);}else assert.equal(bytes.subarray(1,4).toString(),'PNG');
  }
  assert.equal(requests.some(request=>!request.startsWith(url)&&!request.startsWith('data:')),false,JSON.stringify(requests));
  await page.evaluate(()=>{document.documentElement.style.cssText='--bg:#fff;--panel:#f5f6f7;--raised:#e5e9ed;--ink:#151a1e;--muted:#515d69;--line:#c7ced5;--accent:#087d69';});
  if(process.env.LIVING_SCREENSHOT)await page.screenshot({path:process.env.LIVING_SCREENSHOT.replace('.png','-light.png')});
  await page.evaluate(()=>window.show({tables:[],links:[]}));await page.getByText('No tables available.',{exact:true}).waitFor();
  assert.deepEqual(errors,[]);
  console.log('Living ERD browser checks passed: nonblank render, semantic zoom, junction toggle/search, hover, drag/pin, reload/snapshot isolation, mobile containment, SVG/PNG exports and offline requests.');
} catch(error) { console.log('Browser errors',errors);if(process.env.LIVING_SCREENSHOT)await page.screenshot({path:process.env.LIVING_SCREENSHOT.replace('.png','-failure.png')});throw error; } finally {await browser.close();await new Promise(resolve=>server.close(resolve));}
