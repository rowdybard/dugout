import test from 'node:test';
import assert from 'node:assert/strict';
import {handleFeedKey,type KeyCheck} from '../lib/runner/feed-key.ts';
import {runnerError} from '../lib/runner/protocol.ts';
import type {RunnerBindings,RunnerDatabase} from '../lib/runner/sites-proxy';

const CHAD='u_chad_account_1234',SITE='https://dugout.example.workers.dev';
const SECRET=Buffer.alloc(32,7).toString('base64');
const env:RunnerBindings={DUGOUT_OWNER_ID:'u_owner_account_99',DUGOUT_RUNNER_USERS:'*',DUGOUT_RUNNER_URL:'https://runner.example.workers.dev',DUGOUT_RUNNER_SECRET:'synthetic-secret-at-least-thirty-two-characters'};
function database(mode:'active'|'frozen'|null):RunnerDatabase {
  return {prepare:()=>({bind:()=>({first:async()=>mode?{owner_id:CHAD,mode,epoch:'epoch-chad',migration_id:'m',snapshot:'{}',revision:1}:null})})} as unknown as RunnerDatabase;
}
function request(body:unknown,{owner=CHAD,origin=SITE}:{owner?:string|null;origin?:string}={}):Request {
  return new Request(`${SITE}/api/tennis/runner/key`,{method:'POST',body:JSON.stringify(body),
    headers:{'content-type':'application/json',origin,'sec-fetch-site':origin===SITE?'same-origin':'cross-site',...(owner?{'oai-authenticated-user-id':owner}:{})}});
}
async function call(req:Request,{mode='active' as 'active'|'frozen'|null,check=(async()=>({state:'verified',message:'ok'})) as unknown as KeyCheck,settings=env}={}){
  const sent:{owner:string;epoch:string;path:string;value:unknown}[]=[];let checked=0;
  const counting:KeyCheck=async secrets=>{checked++;return check(secrets);};
  const send=(async(_env:RunnerBindings,owner:string,epoch:string,path:string,_method:unknown,value:unknown)=>{sent.push({owner,epoch,path,value});return {};}) as never;
  let response:Response;
  try{response=await handleFeedKey(req,database(mode),settings,counting,send);}catch(error){response=runnerError(error);}
  return {status:response.status,body:await response.text(),sent,checked};
}

test('a verified key goes only to the signed-in account\'s own runner and is never echoed back',async()=>{
  const ok=await call(request({keyId:'chad-key-1',secretKey:SECRET}));
  assert.equal(ok.status,200);assert.deepEqual(JSON.parse(ok.body),{feedKey:true});
  assert.ok(!ok.body.includes(SECRET)&&!ok.body.includes('chad-key-1'),'the response never contains the key');
  assert.deepEqual(ok.sent,[{owner:CHAD,epoch:'epoch-chad',path:'/v1/feed-credentials',value:{keyId:'chad-key-1',secretKey:SECRET}}]);
  const removed=await call(request({remove:true}));
  assert.equal(removed.status,200);assert.deepEqual(removed.sent[0].value,{remove:true});
});

test('every refusal: not signed in, another site, not allowed, no runner, bad format, key rejected by Polymarket',async()=>{
  const key={keyId:'chad-key-1',secretKey:SECRET};
  for(const [label,result,status] of [
    ['not signed in',await call(request(key,{owner:null})),401],
    ['another site',await call(request(key,{origin:'https://evil.example'})),403],
    ['not on the runner list',await call(request(key),{settings:{...env,DUGOUT_RUNNER_USERS:''}}),403],
    ['no background runner yet',await call(request(key),{mode:null}),409],
    ['runner not active',await call(request(key),{mode:'frozen'}),409],
    ['missing secret',await call(request({keyId:'chad-key-1'})),400],
    ['extra fields',await call(request({...key,other:1})),400],
    ['bad key id',await call(request({...key,keyId:'bad id!'})),400],
  ] as const){
    assert.equal(result.status,status,label);assert.equal(result.sent.length,0,`${label}: nothing sent`);assert.equal(result.checked,0,`${label}: not even checked`);
  }
  const rejected=await call(request(key),{check:(async()=>({state:'rejected',message:'Polymarket US rejected these credentials.'})) as unknown as KeyCheck});
  assert.equal(rejected.status,400);assert.match(rejected.body,/rejected these credentials/);assert.equal(rejected.sent.length,0,'a key that fails the check is never stored');
});
