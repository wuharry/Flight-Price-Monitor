// UI integration test with explicit mocked Supabase responses. RLS is tested separately in PostgreSQL.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
const built = spawnSync(process.execPath, ['scripts/build-web.mjs'], { env: { ...process.env, SUPABASE_URL: 'https://testproject.supabase.co', SUPABASE_PUBLISHABLE_KEY: 'sb_publishable_test_only' }, encoding: 'utf8' });
assert.equal(built.status, 0, built.stderr);
const files = { '/': ['index.html','text/html'], '/app.js': ['app.js','text/javascript'], '/style.css': ['style.css','text/css'] };
const server = createServer(async (req,res) => { const file = files[req.url]; if (!file) {res.writeHead(404);res.end();return;} res.setHeader('Content-Type',file[1]);res.end(await readFile('web-dist/'+file[0])); });
await new Promise(r => server.listen(0,'127.0.0.1',r));
const browser = await chromium.launch({ channel: 'msedge', headless: true });
try {
 const page = await browser.newPage({viewport:{width:1280,height:900}}); const errors=[]; page.on('pageerror',e=>errors.push(e.message));
 const user={id:'10000000-0000-4000-8000-000000000001',email:'first-user@example.com',aud:'authenticated',role:'authenticated',email_confirmed_at:new Date().toISOString(),app_metadata:{},user_metadata:{},created_at:new Date().toISOString()};
 const access=['e30',Buffer.from(JSON.stringify({sub:user.id,exp:Math.floor(Date.now()/1000)+3600,role:'authenticated'})).toString('base64url'),'test'].join('.');
 let rules=[];
 await page.route('https://testproject.supabase.co/**',async route=>{
  const req=route.request(),url=new URL(req.url());let data={};
  if(url.pathname==='/auth/v1/token') data={access_token:access,refresh_token:'test-refresh',token_type:'bearer',expires_in:3600,user};
  else if(url.pathname==='/auth/v1/user') data=user;
  else if(url.pathname==='/auth/v1/logout') data={};
  else if(url.pathname==='/rest/v1/watch_rules') {
   if(req.method()==='POST'){const b=req.postDataJSON();rules.push({...b,id:'20000000-0000-4000-8000-000000000002',created_at:new Date().toISOString()});data={id:rules[0].id};}
   else if(req.method()==='PATCH'){Object.assign(rules[0],req.postDataJSON());data={id:rules[0].id};}
   else data=rules;
  } else if(url.pathname==='/rest/v1/price_history')data=[];
  await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify(data)});
 });
 await page.goto('http://127.0.0.1:'+server.address().port+'/');
 await mkdir('artifacts/website',{recursive:true});await page.screenshot({path:'artifacts/website/login.png',fullPage:true});
 await page.locator('#login-email').fill(user.email);await page.locator('#login-password').fill('test-password-only');await page.locator('#login').click();
 await page.locator('#dashboard').waitFor({state:'visible'});
 await page.locator('[name=departure_date]').fill('2027-02-10');await page.locator('[name=target_price]').fill('6500');
 await page.getByRole('button',{name:'儲存監控',exact:true}).click();await page.locator('.watch').waitFor();
 assert.equal(rules[0].user_id,user.id);
 await page.getByRole('button',{name:'停用',exact:true}).click();await page.getByRole('button',{name:'啟用',exact:true}).waitFor();
 assert.equal(rules[0].enabled,false);
 await page.screenshot({path:'artifacts/website/dashboard.png',fullPage:true});
 await page.setViewportSize({width:390,height:844});assert.ok(await page.evaluate('document.documentElement.scrollWidth <= innerWidth'));
 await page.screenshot({path:'artifacts/website/mobile.png',fullPage:true});
 await page.locator('#logout').click();await page.locator('#auth').waitFor({state:'visible'});
 assert.equal(await page.locator('.watch').count(),0);assert.deepEqual(errors,[]);
 console.log('PASS: login, create owned rule, pause rule, empty history, logout clears data, mobile layout. Supabase HTTP mocked; database isolation tested separately.');
} finally {await browser.close();await new Promise(r=>server.close(r));}
