const assert=require('node:assert/strict');const{chromium}=require('playwright');
const{server,wss,access}=require('../server');const{passwordRecord}=require('../access');
(async()=>{
  access.configure(await passwordRecord('pack-audio-test-password'));await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}/`;
  const browser=await chromium.launch({headless:true,executablePath:'C:/Program Files/Google/Chrome/Application/chrome.exe'});
  try{
    const context=await browser.newContext();await context.addInitScript(()=>{window.__packPeaks=[];const start=AudioBufferSourceNode.prototype.start;AudioBufferSourceNode.prototype.start=function(...args){if(Math.abs(this.buffer?.duration-.25)<.001){let peak=0;for(let c=0;c<this.buffer.numberOfChannels;c++)for(const x of this.buffer.getChannelData(c))peak=Math.max(peak,Math.abs(x));window.__packPeaks.push(peak);}return start.apply(this,args);};});
    const rate=16000,count=4000,wav=Buffer.alloc(44+count*2);wav.write('RIFF');wav.writeUInt32LE(wav.length-8,4);wav.write('WAVEfmt ',8);wav.writeUInt32LE(16,16);wav.writeUInt16LE(1,20);wav.writeUInt16LE(1,22);wav.writeUInt32LE(rate,24);wav.writeUInt32LE(rate*2,28);wav.writeUInt16LE(2,32);wav.writeUInt16LE(16,34);wav.write('data',36);wav.writeUInt32LE(count*2,40);for(let i=0;i<count;i++)wav.writeInt16LE(Math.round(31000*Math.sin(2*Math.PI*220*i/rate)),44+i*2);
    let requests=0;await context.route('**/audio/packs/test-tone.wav',route=>{requests++;return route.fulfill({status:200,contentType:'audio/wav',body:wav});});
    await context.addInitScript(()=>localStorage.setItem('river_audio',JSON.stringify({music:false,sfx:true})));
    const page=await context.newPage(),errors=[],assets=[];
    page.on('pageerror',e=>errors.push(e.message));
    page.on('request',request=>{const pathname=new URL(request.url()).pathname;if(pathname.startsWith('/audio/'))assets.push(pathname);});
    await page.goto(base);await page.getByLabel('访问密码').fill('pack-audio-test-password');await page.getByRole('button',{name:'验证并进入'}).click();
    await page.locator('#musicToggle').waitFor();
    assert.deepEqual(assets,[]);
    await page.locator('#musicToggle').click();
    await page.waitForFunction(()=>document.getElementById('audioStatus').textContent.includes('72 BPM'));
    assert.deepEqual(assets.filter(url=>url.endsWith('-jazz.wav')),['/audio/lounge-jazz.wav']);
    assert.ok(assets.every(url=>['/audio/tap.wav','/audio/lounge-jazz.wav'].includes(url)));
    await page.evaluate(()=>RiverAudio.playPack('/audio/packs/test-tone.wav'));await page.waitForFunction(()=>window.__packPeaks.length===1);
    assert.ok((await page.evaluate(()=>window.__packPeaks[0]))<=.350001);assert.equal(requests,1);
    await page.evaluate(()=>RiverAudio.playPack('https://example.com/forged.wav'));assert.equal(requests,1);
    await page.locator('#sfxToggle').click();await page.evaluate(()=>RiverAudio.playPack('/audio/packs/test-tone.wav'));assert.equal(await page.evaluate(()=>window.__packPeaks.length),1);
    await page.locator('#sfxToggle').click();await page.evaluate(()=>RiverAudio.playPack('/audio/packs/test-tone.wav'));await page.waitForFunction(()=>window.__packPeaks.length===2);assert.equal(requests,1);assert.deepEqual(errors,[]);
    console.log('Phrase audio pack QA passed: real WAV decoding/playback, <=0.35 normalized peak, cache, SFX mute, external URL rejection.');
  }finally{await browser.close();for(const ws of wss.clients)ws.terminate();await new Promise(r=>wss.close(r));await new Promise(r=>server.close(r));}
})().catch(error=>{console.error(error);process.exitCode=1;});
