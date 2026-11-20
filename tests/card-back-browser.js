const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const {chromium}=require('playwright');
const {server,wss,access,roomManager}=require('../server');
const {passwordRecord}=require('../access');

(async()=>{
  access.configure(await passwordRecord('card-back-test-only'));
  roomManager.configureTimings({deal:1800,action:30});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+server.address().port;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  const errors=[],contexts=[];
  let externalRequests=0;
  async function open(width,code){
    const context=await browser.newContext({viewport:{width,height:844}});
    contexts.push(context);
    await context.route('**/assets/river-card-back.svg',route=>{externalRequests++;return route.abort();});
    await context.addInitScript(()=>localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:false})));
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base+(code?'#room='+code:''));
    await page.getByLabel('访问密码').fill('card-back-test-only');
    await page.getByRole('button',{name:'验证并进入'}).click();
    await page.waitForFunction(()=>!!window.RiverSession);
    if(code){
      await page.waitForFunction(()=>wsConnected&&mySeatId===1);
      await page.locator('#readyBtn').click();
      await page.waitForFunction(()=>!RiverSession.getDiagnostics().pending);
    }else{
      await page.locator('#createBtn').click();
      await page.locator('#waitTip').filter({hasText:'房间已创建'}).waitFor();
    }
    return page;
  }
  async function checkBacks(page,selector){
    const results=await page.locator(selector).evaluateAll(async elements=>{
      return Promise.all(elements.map(async element=>{
        const css=getComputedStyle(element),image=css.backgroundImage;
        const match=image.match(/url\(["']?(data:image\/svg\+xml,[^"')]+)["']?\)/);
        if(!match)return {inline:false,image};
        const picture=new Image();picture.src=match[1];await picture.decode();
        const canvas=document.createElement('canvas');canvas.width=96;canvas.height=132;
        const context=canvas.getContext('2d');context.drawImage(picture,0,0,96,132);
        const pixels=context.getImageData(0,0,96,132).data;
        let gold=0;
        for(let index=0;index<pixels.length;index+=4)if(pixels[index]>140&&pixels[index+1]>110&&pixels[index+2]<190&&pixels[index+3]>220)gold++;
        return {inline:true,gold,width:element.clientWidth,height:element.clientHeight};
      }));
    });
    assert.ok(results.length>0,selector+' should exist');
    assert.ok(results.every(result=>result.inline&&result.gold>300&&result.width>0&&result.height>0),JSON.stringify(results));
  }
  try{
    const source=(await fs.readFile(path.join(__dirname,'../public/assets/river-card-back.svg'),'utf8')).trim().replace(/\s+/g,' ');
    const style=await fs.readFile(path.join(__dirname,'../public/river-theme.css'),'utf8');
    const inline=style.match(/--river-back:url\("data:image\/svg\+xml,([^"]+)"\)/);
    assert.ok(inline,'Card artwork should be available with the theme');
    assert.equal(decodeURIComponent(inline[1]),source,'Embedded artwork must match the editable SVG');
    for(const width of [390,1280]){
      const host=await open(width),code=await host.locator('#displayRoomCode').textContent(),guest=await open(width,code);
      await host.locator('#startBtn').click();
      for(const page of [host,guest]){
        await page.locator('.deal-deck').waitFor();
        await checkBacks(page,'.deal-deck,.flying-card,.card-back');
      }
      for(const page of [host,guest]){
        await page.locator('#dealingStage').waitFor({state:'hidden'});
        await checkBacks(page,'.card-back');
        assert.equal(await page.locator('.card-back').count(),2);
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
      }
      await guest.reload();
      await guest.waitForFunction(()=>wsConnected&&clientGameState?.phase==='pre_flop');
      await checkBacks(guest,'.card-back');
      await fs.mkdir(path.join(__dirname,'screenshots'),{recursive:true});
      await guest.screenshot({path:path.join(__dirname,'screenshots','card-back-first-hand-'+width+'.png')});
      for(const context of contexts.splice(0))await context.close();
    }
    assert.equal(externalRequests,0,'Card backs must not wait for a separate image request');
    assert.deepEqual(errors,[]);
    console.log('Card backs passed: 2 cold clients at mobile/desktop widths, blocked external artwork, dealing, first round and reload; decoded artwork includes gold details.');
  }finally{
    await browser.close();
    for(const socket of wss.clients)socket.terminate();
    await new Promise(resolve=>wss.close(resolve));
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
