/* Push the same committed master revision to both hosting services. */
const path=require('node:path');
const {spawnSync}=require('node:child_process');
const root=path.resolve(__dirname,'..'),git=process.env.GIT_EXECUTABLE||'git';
const capture=args=>spawnSync(git,args,{cwd:root,encoding:'utf8',windowsHide:true});
const status=capture(['status','--porcelain']);
if(status.status!==0){console.error('Cannot read repository status. Check Git installation.');process.exit(1);}
if(status.stdout.trim()){console.error('Commit local changes before syncing both repositories.');process.exit(1);}
const branch=capture(['symbolic-ref','--quiet','--short','HEAD']);
if(branch.status!==0||branch.stdout.trim()!=='master'){console.error('Switch to local master before syncing both repositories.');process.exit(1);}
const head=capture(['rev-parse','refs/heads/master']);
if(head.status!==0){console.error('Local master branch is missing.');process.exit(1);}
const revision=head.stdout.trim(),targets=[['origin','master'],['github','main']];
let failed=false;
for(const [remote,branch] of targets){
  console.log(`Pushing ${remote}/${branch}...`);
  const result=spawnSync(git,['push',remote,`refs/heads/master:refs/heads/${branch}`],{cwd:root,stdio:'inherit',windowsHide:true});
  if(result.status!==0){console.error(`${remote}/${branch} was not synced. Fix the reported connection or authentication error and rerun.`);failed=true;continue;}
  const check=capture(['ls-remote',remote,`refs/heads/${branch}`]);
  if(check.status!==0||check.stdout.trim().split(/\s+/)[0]!==revision){console.error(`${remote}/${branch} could not be verified.`);failed=true;}
  else console.log(`Verified ${remote}/${branch}: ${revision.slice(0,7)}`);
}
if(failed){console.error('Repositories are not fully synced. Rerun after resolving the errors.');process.exitCode=1;}
else console.log(`Both repositories are synced to ${revision.slice(0,7)}.`);
