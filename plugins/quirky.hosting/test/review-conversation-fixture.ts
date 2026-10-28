export const conversationFixture = String.raw`
import {readFileSync,writeFileSync,renameSync} from 'node:fs';
const p=process.env.QUIRKY_TEST_FIXTURE_DIR+'/state.json';
const state=JSON.parse(readFileSync(p,'utf8')); const args=process.argv.slice(2);
const input=JSON.parse(process.env.QUIRKY_TEST_GH_INPUT||'{}');
const save=()=>{const t=p+'.'+process.pid;writeFileSync(t,JSON.stringify(state));renameSync(t,p)};
const out=v=>process.stdout.write(typeof v==='string'?v:JSON.stringify(v));
const fail=s=>{process.stderr.write(s);process.exit(1)};
const idx=args.indexOf('--method');const short=args.indexOf('-X');const method=String(idx>=0?args[idx+1]:short>=0?args[short+1]:'GET').toUpperCase();
const endpoint=args.find(a=>a.startsWith('repos/'))||'';
const pr={number:7,id:'PR7',title:'Review title',body:'Original body',state:'OPEN',url:'https://github.com/test-owner/test-repo/pull/7',isDraft:false,baseRefName:'main',baseRefOid:'b'.repeat(40),headRefName:'feature',headRefOid:'a'.repeat(40),headRepositoryOwner:{login:'test-owner'},headRepository:{name:'test-repo',owner:{login:'test-owner'}},mergeable:'MERGEABLE',mergeStateStatus:'CLEAN',reviewDecision:'APPROVED',statusCheckRollup:[],autoMergeRequest:null};
if(args[0]==='--version'){out('gh version 2.70.0');}
else if(args[0]==='auth'&&args[1]==='status'){out('Logged in to github.com account test-user (keyring)\n');}
else if(args[0]==='auth'&&args[1]==='token'){out('fixture-token\n');}
else if(args[0]==='pr'&&args[1]==='view'){if(Number(args[2])!==7)fail('no pull requests found');out(pr);}
else if(args[0]==='repo'&&args[1]==='view'){out({defaultBranchRef:{name:'main'}});}
else if(args[0]==='api'&&args.includes('rate_limit')){out({resources:{core:{limit:5000,remaining:4000,reset:1999999999},graphql:{limit:5000,remaining:4000,reset:1999999999},search:{limit:30,remaining:30,reset:1999999999}}});}
else if(args[0]==='api'&&args.includes('graphql')){
 if(typeof input.query==='string'&&input.query.includes('entries(first: 100)'))out(state.stackGraph||{data:{repository:{pullRequest:{stack:null}}}});
 else out({data:{repository:{viewerDefaultMergeMethod:'SQUASH',mergeCommitAllowed:true,rebaseMergeAllowed:true,squashMergeAllowed:true,autoMergeAllowed:true,defaultBranchRef:{name:'main'},mergeQueue:null,ref:{rules:{nodes:[]}}}}});
}
else if(endpoint==='repos/test-owner/test-repo/pulls/7'&&method==='GET'){out({number:7,state:'open',title:pr.title,body:pr.body,html_url:pr.url,stack:state.stack??null,base:{ref:'main',sha:pr.baseRefOid,repo:{name:'test-repo',owner:{login:'test-owner'}}},head:{ref:'feature',sha:pr.headRefOid,repo:{name:'test-repo',owner:{login:'test-owner'}}}});}
else if(endpoint==='repos/test-owner/test-repo/issues/7/comments'&&method==='POST'){
 if(state.failWrite)fail('HTTP 403: forbidden');const id=(state.nextId||100)+1;state.nextId=id;const c={id,body:input.body,issue_url:'https://api.github.com/repos/test-owner/test-repo/issues/7',html_url:pr.url+'#issuecomment-'+id,created_at:'2026-10-27T12:00:00Z',user:{login:'test-user'}};state.comments=[...(state.comments||[]),c];save();out(c);
}
else if(/repos\/test-owner\/test-repo\/issues\/comments\/\d+$/.test(endpoint)){
 const id=Number(endpoint.split('/').at(-1));const c=(state.comments||[]).find(c=>c.id===id);if(!c)fail('HTTP 404: Not Found');
 if(method==='GET')out(c);
 else if(state.failWrite)fail('HTTP 403: forbidden');
 else if(method==='PATCH'){c.body=input.body;save();out(c)}
 else if(method==='DELETE'){state.comments=state.comments.filter(c=>c.id!==id);save();out('')}
 else fail('unexpected comment method');
}
else if(endpoint==='repos/test-owner/test-repo/issues/7/assignees'){
 if(method==='GET')out((state.assignees||[]).map(login=>({login})));
 else if(state.failWrite)fail('HTTP 403: forbidden');
 else {const names=input.assignees||[];state.assignees=method==='DELETE'?(state.assignees||[]).filter(login=>!names.includes(login)):[...new Set([...(state.assignees||[]),...names])];save();out({assignees:state.assignees.map(login=>({login}))})}
}
else if(endpoint==='repos/test-owner/test-repo/issues/7'&&method==='PATCH'){
 if(state.failWrite)fail('HTTP 403: forbidden');state.assignees=input.assignees;save();out({assignees:state.assignees.map(login=>({login}))});
}
else fail('unexpected fixture route '+JSON.stringify(args));
`
