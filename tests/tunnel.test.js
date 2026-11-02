const {test}=require('node:test');
const assert=require('node:assert/strict');
const {findCloudflared}=require('../tunnel');
test('tunnel executable prefers configured path, then the actual server folder, then PATH',()=>{
  const directory='E:\\bluff',env={CLOUDFLARED_PATH:'"D:\\Tunnel Tools\\cloudflared.exe"',PATH:'C:\\Windows;"C:\\Program Files\\cloudflared"'};
  const files=new Set(['D:\\Tunnel Tools\\cloudflared.exe','E:\\bluff\\cloudflared.exe','C:\\Program Files\\cloudflared\\cloudflared.exe']);
  const find=()=>findCloudflared({directory,platform:'win32',env,isFile:file=>files.has(file)});
  assert.equal(find(),'D:\\Tunnel Tools\\cloudflared.exe');files.delete(find());assert.equal(find(),'E:\\bluff\\cloudflared.exe');files.delete(find());assert.equal(find(),'C:\\Program Files\\cloudflared\\cloudflared.exe');
});
test('missing tool returns null and does not depend on an old checkout or current directory',()=>{
  assert.equal(findCloudflared({directory:'E:\\bluff',platform:'win32',env:{PATH:''},isFile:file=>file==='E:\\update\\cloudflared.exe'}),null);
});
test('Unix finds installed executables and retains the legacy temporary location',()=>{
  const find=files=>findCloudflared({directory:'/srv/bluff',platform:'linux',env:{PATH:'/usr/bin:/usr/local/bin'},isFile:file=>files.includes(file)});
  assert.equal(find(['/usr/local/bin/cloudflared']),'/usr/local/bin/cloudflared');assert.equal(find(['/tmp/cloudflared']),'/tmp/cloudflared');
});
