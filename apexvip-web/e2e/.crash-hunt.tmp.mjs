import { chromium } from 'playwright';
import http from 'node:http';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
const ROOT='/home/user/BallrzAPP';
const server=http.createServer((req,res)=>{const p=join(ROOT,decodeURIComponent((req.url||'/').split('?')[0]));
  if(!existsSync(p)||!statSync(p).isFile()){res.writeHead(404);res.end();return;}
  res.writeHead(200,{'Content-Type':extname(p)==='.html'?'text/html':(extname(p)==='.js'?'text/javascript':'application/octet-stream')});createReadStream(p).pipe(res);});
await new Promise(ok=>server.listen(4184,ok));
const browser=await chromium.launch({executablePath:process.env.PW_CHROMIUM});
const page=await browser.newPage({viewport:{width:390,height:844}});
await page.route(/^https?:\/\/(?!localhost)/,r=>r.abort());
await page.addInitScript(()=>{localStorage.setItem('apex_consent','all');localStorage.setItem('apexvip_guide_seen','1');});
page.on('pageerror',e=>console.log('PAGEERROR:', e.message));
await page.goto('http://localhost:4184/apexvip-client.html',{waitUntil:'domcontentloaded'});
// Simulate the signed-in state and render every main screen; capture any throw.
const screens=['home','trips','profile','notifications','concierge-chat','preferences','help','referral'];
for(const sc of screens){
  const r=await page.evaluate((sc)=>{
    try{
      state.user={uid:'u1',name:'Test User',email:'t@t.com'};
      state.screen=sc;
      renderNow();
      const boundary=document.body.innerText.includes('Something went wrong');
      return {sc, ok:!boundary, boundary};
    }catch(e){ return {sc, ok:false, err:(e&&e.stack||String(e)).split('\n').slice(0,4).join(' | ')}; }
  },sc);
  console.log(JSON.stringify(r));
  // read what the crash boundary recorded
  if(!r.ok){
    const logged=await page.evaluate(()=>JSON.parse(localStorage.getItem('apexvip_errors')||'[]').slice(-1));
    console.log('LOGGED:', JSON.stringify(logged));
  }
}
await browser.close(); server.close();
