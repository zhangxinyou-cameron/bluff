const fs=require('node:fs');
const path=require('node:path');

// Use an explicit executable path; never invoke a shell to search or launch it.
function findCloudflared({directory=__dirname,platform=process.platform,env=process.env,isFile=file=>{try{return fs.statSync(file).isFile();}catch(_){return false;}}}={}){
  const paths=platform==='win32'?path.win32:path.posix,name=platform==='win32'?'cloudflared.exe':'cloudflared';
  const clean=value=>String(value||'').trim().replace(/^"(.*)"$/,'$1');
  const candidates=[];
  if(clean(env.CLOUDFLARED_PATH))candidates.push(paths.resolve(directory,clean(env.CLOUDFLARED_PATH)));
  candidates.push(paths.join(directory,name));
  for(const entry of String(env.PATH||env.Path||'').split(platform==='win32'?';':':'))if(clean(entry))candidates.push(paths.join(clean(entry),name));
  if(platform!=='win32')candidates.push('/tmp/cloudflared');
  return candidates.find(isFile)||null;
}
module.exports={findCloudflared};
