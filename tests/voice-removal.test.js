const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs');const path=require('node:path');
test('live microphone and relay are removed, optional phrase files retain a bounded audio path',()=>{
  const root=path.join(__dirname,'..'),html=fs.readFileSync(path.join(root,'public/index.html'),'utf8'),server=fs.readFileSync(path.join(root,'server.js'),'utf8');
  assert.doesNotMatch(html,/voiceDock|voice\.js|voiceJoinBtn/);assert.doesNotMatch(server,/VoiceRelay|voice\.frame/);
  for(const file of['public/voice.js','public/voice-worklet.js','voice-relay.js'])assert.equal(fs.existsSync(path.join(root,file)),false);
  const audio=fs.readFileSync(path.join(root,'public/audio.js'),'utf8');assert.match(audio,/playPack/);assert.match(audio,/peak>\.35/);assert.doesNotMatch(audio,/getUserMedia/);
});
