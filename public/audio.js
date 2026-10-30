/* All audio is synthesized offline with tools/synthesize_audio.py. */
(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const defaults = { music: true, sfx: true, musicVolume: 28, sfxVolume: 55 };
  const tracks = [
    { file:'lounge-jazz', title:'午夜河岸', bpm:72 },
    { file:'rain-jazz', title:'雨后慢拍', bpm:68 },
    { file:'moon-jazz', title:'窗边月色', bpm:74 }
  ];
  let preferences = { ...defaults };
  try {
    const saved = JSON.parse(localStorage.getItem('river_audio') || '{}');
    for (const key of ['music', 'sfx']) if (typeof saved[key] === 'boolean') preferences[key] = saved[key];
    for (const key of ['musicVolume', 'sfxVolume']) if (Number.isFinite(saved[key])) preferences[key] = Math.max(0, Math.min(100, saved[key]));
  } catch (_) {}
  let context, musicGain, sfxGain, musicSource, loading;
  let trackIndex = 0, musicNode = null, trackTimer = null, switchId = 0;
  let unlocked = false;
  const buffers = new Map();
  const loads = new Map();
  const voices = new Set();
  const names = ['tap', 'chips', 'ready', 'deal', 'fold', 'leave'];
  const status = text => { byId('audioStatus').textContent = text; };
  function save() { try { localStorage.setItem('river_audio', JSON.stringify(preferences)); } catch (_) {} }
  function refresh() {
    for (const key of ['music', 'sfx']) {
      byId(key + 'Toggle').setAttribute('aria-pressed', String(preferences[key]));
      byId(key + 'Toggle').textContent = (key === 'music' ? '♫ 音乐' : '♪ 音效') + (preferences[key] ? '' : ' 关');
    }
    for (const key of ['musicVolume', 'sfxVolume']) byId(key).value = preferences[key];
    if (context) {
      const now = context.currentTime;
      for (const [gain, value] of [[musicGain, preferences.music ? preferences.musicVolume/100*.45 : 0], [sfxGain, preferences.sfx ? preferences.sfxVolume/100*.45 : 0]]) {
        gain.gain.cancelScheduledValues(now);
        gain.gain.setTargetAtTime(value, now, .06);
      }
    }
  }
  function load(name) {
    if (buffers.has(name)) return Promise.resolve();
    if (loads.has(name)) return loads.get(name);
    const request = (async () => {
      const response = await fetch('/audio/' + name + '.wav');
      if (!response.ok || !response.headers.get('content-type')?.startsWith('audio/')) throw new Error('Audio unavailable');
      const buffer = await context.decodeAudioData(await response.arrayBuffer());
      buffers.set(name, buffer);
    })().finally(() => loads.delete(name));
    loads.set(name, request);
    return request;
  }
  function startMusic() {
    if (musicSource) return;
    void switchTrack(trackIndex);
  }
  async function switchTrack(index) {
    if (!context) return;
    const id = ++switchId;
    clearTimeout(trackTimer);
    const target = (index+tracks.length)%tracks.length;
    try {
      await load(tracks[target].file);
      if (id!==switchId) return;
      const oldSource=musicSource, oldNode=musicNode;
      trackIndex=target;
      musicSource=context.createBufferSource();
      musicNode=context.createGain();
      musicSource.buffer=buffers.get(tracks[target].file);
      musicSource.loop=true;
      const now=context.currentTime;
      musicNode.gain.setValueAtTime(0,now);
      musicNode.gain.linearRampToValueAtTime(1,now+.7);
      musicSource.connect(musicNode); musicNode.connect(musicGain); musicSource.start();
      if (oldSource) {
        oldNode.gain.cancelScheduledValues(now);
        oldNode.gain.setValueAtTime(oldNode.gain.value,now);
        oldNode.gain.linearRampToValueAtTime(0,now+.7);
        oldSource.onended=()=>{oldSource.disconnect();oldNode.disconnect();};
        oldSource.stop(now+.75);
      }
      byId('trackTitle').textContent=tracks[target].title;
      status(`慢拍爵士 · ${tracks[target].bpm} BPM · ${target+1}/${tracks.length}`);
      if (preferences.music) {
        trackTimer=setTimeout(()=>{void switchTrack(trackIndex+1);},(musicSource.buffer.duration-.8)*1000);
        void load(tracks[(target+1)%tracks.length].file).catch(()=>{});
      }
    } catch (_) { status('曲目加载失败，点击下一首重试'); }
  }
  async function unlock() {
    unlocked = true;
    if (!preferences.music && !preferences.sfx) return;
    try {
      if (!context) {
        const AudioContext = window.AudioContext || window.webkitAudioContext;
        if (!AudioContext) { status('当前浏览器不支持音频'); return; }
        context = new AudioContext();
        musicGain = context.createGain();
        sfxGain = context.createGain();
        musicGain.gain.value = 0;
        sfxGain.gain.value = 0;
        const compressor = context.createDynamicsCompressor();
        compressor.threshold.value = -12;
        compressor.knee.value = 12;
        compressor.ratio.value = 16;
        compressor.attack.value = .003;
        compressor.release.value = .15;
        const master = context.createGain();
        master.gain.value = .8;
        const limiter = context.createWaveShaper();
        // All sources, including optional phrase packs, share this peak limiter.
        limiter.curve = Float32Array.from({ length: 4097 }, (_, i) => .42 * Math.tanh((i/2048-1)/.42));
        limiter.oversample = '4x';
        musicGain.connect(compressor);
        sfxGain.connect(compressor);
        compressor.connect(master);
        master.connect(limiter);
        limiter.connect(context.destination);
        refresh();
      }
      if (context.state === 'suspended' && !document.hidden) await context.resume();
      if (!loading) {
        status('正在准备慢拍爵士…');
        loading = Promise.allSettled([...names, tracks[trackIndex].file].map(load)).then(results => {
          startMusic();
          const failed = results.some(result => result.status === 'rejected');
          if (failed) status('部分音频加载失败，点击声音按钮重试');
          if (failed) loading = null;
        });
      }
      await loading;
    } catch (_) { loading = null; status('音频暂未开启，点击声音按钮重试'); }
  }
  function play(name) {
    if (!context || !preferences.sfx) return;
    if (!buffers.has(name)) { load(name).then(() => play(name)).catch(() => {}); return; }
    if (context.state !== 'running') return;
    if (voices.size >= 4) return; // Cap overlapping voices so rapid taps cannot pile up.
    const source = context.createBufferSource();
    source.buffer = buffers.get(name);
    source.connect(sfxGain);
    voices.add(source);
    source.onended = () => { voices.delete(source); source.disconnect(); };
    source.start();
  }
  function soundFor(target) {
    if(target.matches('#bankBorrowBtn, #bankRepayBtn')) return 'chips';
    if (target.matches('#startBtn, #nextHandBtn, .action-next')) return 'deal';
    if (target.matches('#readyBtn, #confirmJoinBtn, .action-confirm')) return 'ready';
    if (target.matches('.action-fold, .action-cancel')) return 'fold';
    if (target.matches('#leaveBtn')) return 'leave';
    if (target.matches('.action-raise, .action-call, .action-allin, .mini-btn')) return 'chips';
    return 'tap';
  }
  // Capture delegates include buttons created later by the game renderer.
  document.addEventListener('pointerdown', () => { void unlock(); }, { capture: true });
  document.addEventListener('keydown', event => { if (['Enter', ' '].includes(event.key)) void unlock(); }, { capture: true });
  document.addEventListener('click', event => {
    const target = event.target.closest('button, [role="button"], summary');
    if (!target || target.disabled || target.id === 'sfxToggle') return;
    play(soundFor(target));
  }, { capture: true });
  document.addEventListener('change', event => { if (event.target.matches('select, input[type="range"]')) play('tap'); }, { capture: true });
  for (const key of ['music', 'sfx']) byId(key + 'Toggle').addEventListener('click', () => {
    preferences[key] = !preferences[key];
    refresh(); save(); void unlock();
    if (key === 'sfx' && preferences.sfx) play('tap');
    if (key === 'music') {
      clearTimeout(trackTimer);
      if (preferences.music && musicSource) trackTimer=setTimeout(()=>{void switchTrack(trackIndex+1);},Math.max(1,musicSource.buffer.duration-.8)*1000);
    }
  });
  byId('nextTrackBtn').addEventListener('click', async () => {
    preferences.music=true;refresh();save();
    await unlock();await switchTrack(trackIndex+1);
  });
  async function playPack(url){
    if(!context||!preferences.sfx||document.hidden||!/^\/audio\/packs\/[\w\-/]+\.(wav|mp3|ogg)$/.test(url))return;
    const key='pack:'+url;
    try{
      if(!buffers.has(key)){
        if(!loads.has(key))loads.set(key,(async()=>{
          const response=await fetch(url);if(!response.ok)throw new Error('Pack unavailable');
          const bytes=await response.arrayBuffer();if(bytes.byteLength>8*1024*1024)throw new Error('Pack too large');
          const buffer=await context.decodeAudioData(bytes);if(buffer.duration>15)throw new Error('Pack exceeds 15 seconds');
          let peak=0;for(let c=0;c<buffer.numberOfChannels;c++)for(const sample of buffer.getChannelData(c))peak=Math.max(peak,Math.abs(sample));
          if(peak>.35)for(let c=0;c<buffer.numberOfChannels;c++){const channel=buffer.getChannelData(c);for(let i=0;i<channel.length;i++)channel[i]*=.35/peak;}
          buffers.set(key,buffer);
        })().finally(()=>loads.delete(key)));
        await loads.get(key);
      }
      if(!document.hidden)play(key);
    }catch(_){/* Missing optional packs leave the text message fully usable. */}
  }
  window.RiverAudio={play,playPack};
  for (const key of ['musicVolume', 'sfxVolume']) byId(key).addEventListener('input', event => {
    preferences[key] = Number(event.target.value);
    refresh(); save();
  });
  document.addEventListener('visibilitychange', () => {
    if (!context || !unlocked) return;
    if (document.hidden) { clearTimeout(trackTimer); context.suspend().catch(() => {}); }
    else { void unlock(); if (preferences.music && musicSource) trackTimer=setTimeout(()=>{void switchTrack(trackIndex+1);},musicSource.buffer.duration*1000); }
  });
  refresh();
})();
