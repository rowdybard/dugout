import test from 'node:test';
import assert from 'node:assert/strict';
import {localMoveUpgradeRules,startPaperBot} from '../lib/tennis/start-control.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
import {defaultTennisConfig} from '../lib/tennis/rules.ts';
import type {TennisAction,TennisRuntime} from '../lib/tennis/types';

const runtime=(mode:TennisRuntime['mode']):TennisRuntime=>({mode,intervalMs:2500,backgroundConnected:mode==='service',streamConfigured:false,description:'Test'});
const session=()=>({...createTennisSession({...defaultTennisConfig(100),focusSlug:'verified-game',leagues:['CFB']},1000),status:'paused' as const});

test('Start records policy upgrade before native resume, without resetting money or starting an observation timer',async()=>{
  const before=session(),snapshot=structuredClone(before),actions:TennisAction[]=[];
  assert.equal(await startPaperBot(before,runtime('service'),async action=>{actions.push(action);return true;},()=>`test-${actions.length}`),true);
  assert.deepEqual(actions,[{action:'update-rules',sessionId:before.id,expectedRulesRevision:0,commandId:'test-0',
    rules:{decisionEngine:'local-move-v1',strategy:'auto',decisionPolicy:'football-context-v1',baselineWindowMs:60000,minimumHistoryMs:30000,minSamples:10,maxSpreadPoints:2,maxBookAgeMs:5000}},
    {action:'resume',sessionId:before.id,commandId:'test-1'}]);
  assert.deepEqual(before,snapshot);
});

test('failed or conflicting policy save prevents resume',async()=>{
  const actions:TennisAction[]=[];
  assert.equal(await startPaperBot(session(),runtime('service'),async action=>{actions.push(action);return false;},()=> 'test-command'),false);
  assert.equal(actions.length,1);assert.equal(actions[0].action,'update-rules');
});

test('explicit upgrade satisfies history floors and tightens data gates without touching stake or loss limits',()=>{
  const config={...session().config,baselineWindowMs:15000,minimumHistoryMs:5000,minSamples:3,maxSpreadPoints:6,maxBookAgeMs:10000};
  assert.deepEqual(localMoveUpgradeRules(config),{decisionEngine:'local-move-v1',strategy:'auto',decisionPolicy:'football-context-v1',baselineWindowMs:30000,minimumHistoryMs:30000,minSamples:10,maxSpreadPoints:2,maxBookAgeMs:5000});
  const strict={...config,baselineWindowMs:90000,minimumHistoryMs:60000,minSamples:30,maxSpreadPoints:1,maxBookAgeMs:2000};
  assert.deepEqual(localMoveUpgradeRules(strict),{decisionEngine:'local-move-v1',strategy:'auto',decisionPolicy:'football-context-v1',baselineWindowMs:90000,minimumHistoryMs:60000,minSamples:30,maxSpreadPoints:1,maxBookAgeMs:2000});
  assert.equal('entryBudget' in localMoveUpgradeRules(config),false);assert.equal('stopReturn' in localMoveUpgradeRules(config),false);
});

test('already current policy resumes without resetting history through a redundant rules update',async()=>{
  const saved=session();saved.config={...saved.config,decisionEngine:'local-move-v1',strategy:'auto',decisionPolicy:'football-context-v1'};
  const actions:TennisAction[]=[];
  await startPaperBot(saved,runtime('browser'),async action=>{actions.push(action);return true;},()=> 'test-command');
  assert.deepEqual(actions,[{action:'resume',sessionId:saved.id,runForMs:10_800_000,commandId:'test-command'}]);
});

test('missing focus, active migration, and an already running bot cannot dispatch Start',async()=>{
  const noFocus=session();noFocus.config.focusSlug=null;
  let calls=0;const perform=async()=>{calls++;return true;};
  assert.equal(await startPaperBot(noFocus,runtime('browser'),perform,()=> 'test'),false);
  assert.equal(await startPaperBot(session(),runtime('migrating'),perform,()=> 'test'),false);
  assert.equal(await startPaperBot({...session(),status:'running'},runtime('service'),perform,()=> 'test'),false);
  assert.equal(calls,0);
});
