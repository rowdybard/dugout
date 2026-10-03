import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import ts from 'typescript';
import * as rules from '../lib/tennis/rules.ts';
import {RunnerError,runnerError} from '../lib/runner/protocol.ts';
import type {TennisAction} from '../lib/tennis/types';

const SESSION='synthetic-session:loss-1';
const COMMAND='43d83b3f-a653-43c1-a635-222681effe3a';
const database={synthetic:true},bindings={DUGOUT_RUNNER_URL:'https://runner.invalid'};
const state={
  originChecks:0,legacyUpdates:0,
  forwarded:[] as {request:Request;database:unknown;bindings:unknown;action:TennisAction}[],
  response:null as Response|null,
  error:null as Error|null,
};
function reset(){
  state.originChecks=0;state.legacyUpdates=0;state.forwarded=[];
  state.response=Response.json({session:{id:SESSION,status:'running'},runtime:{mode:'service'}},{headers:{'Cache-Control':'no-store'}});
  state.error=null;
}

// Load the endpoint itself, retaining real Zod and rules validation while replacing external services.
const require=createRequire(import.meta.url);
const source=readFileSync(new URL('../app/api/tennis/session/route.ts',import.meta.url),'utf8');
const compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const services:Record<string,unknown>={
  'cloudflare:workers':{env:bindings},
  '@/lib/tennis/rules':rules,
  '@/lib/runner/protocol':{runnerError},
  '@/lib/runner/sites-proxy':{
    async proxyRunnerSession(request:Request,db:unknown,env:unknown,action:TennisAction){
      state.forwarded.push({request,database:db,bindings:env,action});
      if(state.error)throw state.error;
      return state.response;
    },
  },
  '@/lib/server/storage':{
    sameOrigin(request:Request){state.originChecks++;assert.equal(request.headers.get('origin'),new URL(request.url).origin);},
    db:()=>database,
    requireUserId:()=> 'synthetic-owner-123',
  },
  '@/lib/tennis/server':{
    async updateTennisSession(){state.legacyUpdates++;throw new Error('Unexpected legacy session update');},
    async readTennisSession(){throw new Error('Unexpected legacy session read');},
    tennisRuntime:()=>({mode:'browser'}),
  },
  '@/lib/tennis/journal-export':{async exportTennisJournal(){throw new Error('Unexpected journal export');}},
};
const endpoint={} as {POST:(request:Request)=>Promise<Response>};
new Function('require','exports',compiled)((specifier:string)=>specifier in services?services[specifier]:require(specifier),endpoint);
function request(body:unknown){
  return new Request('https://test.invalid/api/tennis/session',{method:'POST',headers:{origin:'https://test.invalid','content-type':'application/json','oai-authenticated-user-id':'synthetic-owner-123'},body:JSON.stringify(body)});
}
const acknowledge=(extra:Record<string,unknown>={})=>({action:'acknowledge-loss',sessionId:SESSION,commandId:COMMAND,expectedLossAcknowledgement:null,...extra});

test('session endpoint accepts explicit loss acknowledgement and forwards validated identifiers and duration',async()=>{
  for(const extra of [{},{runForMs:60_000},{runForMs:21_600_000},{expectedLossAcknowledgement:'11111111-1111-4111-8111-111111111111'}]){
    reset();const action=acknowledge(extra),req=request(action),expected=state.response;
    const response=await endpoint.POST(req);
    assert.equal(response,expected);assert.equal(response.status,200);assert.equal(response.headers.get('Cache-Control'),'no-store');
    assert.deepEqual(await response.json(),{session:{id:SESSION,status:'running'},runtime:{mode:'service'}});
    assert.deepEqual(state.forwarded,[{request:req,database,bindings,action}]);
    assert.equal(state.originChecks,1);assert.equal(state.legacyUpdates,0);
  }
});

test('loss acknowledgement requires a valid session identifier and command UUID before contacting the runner',async()=>{
  const valid=acknowledge();
  const withoutSession={action:valid.action,commandId:valid.commandId,expectedLossAcknowledgement:null};
  const withoutCommand={action:valid.action,sessionId:valid.sessionId,expectedLossAcknowledgement:null};
  const withoutAcknowledgement={action:valid.action,sessionId:valid.sessionId,commandId:valid.commandId};
  const invalid:[string,unknown][]=[
    ['missing session',withoutSession],['missing command',withoutCommand],['missing acknowledgement',withoutAcknowledgement],
    ...[null,42,'','wrong session','../other','x'.repeat(251)].map(value=>['session '+String(value),{...valid,sessionId:value}] as [string,unknown]),
    ...[null,42,'','not-a-uuid'].map(value=>['command '+String(value),{...valid,commandId:value}] as [string,unknown]),
    ...[42,'','wrong acknowledgement','../other','x'.repeat(129)].map(value=>['acknowledgement '+String(value),{...valid,expectedLossAcknowledgement:value}] as [string,unknown]),
  ];
  for(const [label,value] of invalid){
    reset();const response=await endpoint.POST(request(value));
    assert.equal(response.status,400,label);assert.deepEqual(await response.json(),{error:'Check the amount and paper-session settings.'},label);
    assert.equal(state.originChecks,1,label);assert.equal(state.forwarded.length,0,label);assert.equal(state.legacyUpdates,0,label);
  }
});

test('loss acknowledgement rejects out-of-range, non-integer, and nonnumeric run duration',async()=>{
  for(const runForMs of [59_999,21_600_001,60_000.5,-60_000,null,'60000']){
    reset();const response=await endpoint.POST(request(acknowledge({runForMs})));
    assert.equal(response.status,400,String(runForMs));assert.equal(state.forwarded.length,0);assert.equal(state.legacyUpdates,0);
  }
});

test('loss acknowledgement rejects unexpected keys rather than forwarding additional controls',async()=>{
  for(const extra of [{bankroll:100},{abandon:true},{config:{}},{rules:{}},{expectedRulesRevision:0},{ownerId:'another-owner-123'}]){
    reset();const response=await endpoint.POST(request(acknowledge(extra)));
    assert.equal(response.status,400,JSON.stringify(extra));assert.equal(state.forwarded.length,0);assert.equal(state.legacyUpdates,0);
  }
});

test('session endpoint preserves a runner rejection for a stale acknowledgement without legacy fallback',async()=>{
  reset();state.error=new RunnerError(409,'The paper session changed. Refresh before acknowledging its loss.');
  const action=acknowledge({sessionId:'synthetic-session:older'});
  const response=await endpoint.POST(request(action));
  assert.equal(response.status,409);assert.deepEqual(await response.json(),{error:state.error.message});
  assert.deepEqual(state.forwarded.map(value=>value.action),[action]);assert.equal(state.legacyUpdates,0);
});
