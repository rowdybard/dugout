import test from 'node:test';
import assert from 'node:assert/strict';
import {boldSize,modeOf,modeRules,steadySize} from '../lib/tennis/modes.ts';
import {applyTennisAction,createTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig,validateTennisConfig} from '../lib/tennis/rules.ts';

test('Steady and Bold sizes stay inside the bot limits for every balance',()=>{
  assert.equal(steadySize(100),5);assert.equal(boldSize(100),12);
  assert.equal(boldSize(1000),50,'capped at $50: both sides fit the $100 exposure cap');
  for(const cash of [5,7,10,25,50,100,250,1000,10000]){
    const base=defaultLiveTennisConfig(cash);
    for(const mode of ['steady','bold'] as const){
      const config={...base,...modeRules(base,mode)};
      assert.equal(validateTennisConfig(config),null,`${mode} on $${cash}`);
      assert.equal(modeOf(config),mode);
      // Both resting buys must fit the open-exposure cap (25% of the balance, at most $100).
      assert.ok(2*config.entryBudget<=Math.min(100,cash*.25)+1e-9||config.entryBudget===steadySize(cash),`${mode} on $${cash}: two sides fit`);
    }
    assert.ok(boldSize(cash)>=steadySize(cash));
  }
});

test('Bold turns Chaos off, and a balance reset keeps the mode at the new size',()=>{
  const base={...defaultLiveTennisConfig(100),entries:'steady' as const,chaosSlugs:['a']};
  assert.deepEqual(modeRules(base,'bold'),{entries:'all',entryBudget:12,chaosSlugs:[]});
  let session=createTennisSession({...defaultLiveTennisConfig(100),...modeRules(defaultLiveTennisConfig(100),'bold')},0);
  session=applyTennisAction(session,{action:'reset',bankroll:500,commandId:'reset-bold'},[],1000);
  assert.equal(modeOf(session.config),'bold');assert.equal(session.config.entryBudget,50);
  session=applyTennisAction(session,{action:'update-rules',sessionId:session.id,expectedRulesRevision:session.rulesRevision??0,commandId:'to-steady',rules:modeRules(session.config,'steady')},[],2000);
  assert.equal(modeOf(session.config),'steady');assert.equal(session.config.entryBudget,5);
});

test('A paper run can start with up to $10,000, and Stop with nothing held ends the run at once',()=>{
  let session=createTennisSession(defaultLiveTennisConfig(100),0);
  session=applyTennisAction(session,{action:'reset',bankroll:10000,commandId:'reset-10k'},[],1000);
  assert.equal(session.config.startingCash,10000);assert.equal(session.cash,10000);assert.equal(session.status,'idle');
  assert.equal(validateTennisConfig({...session.config,...modeRules(session.config,'bold')}),null);
  const refused=applyTennisAction(session,{action:'reset',bankroll:10001,commandId:'reset-too-big'},[],2000);
  assert.equal(refused.config.startingCash,10000);assert.match(refused.lastReason??'',/\$10,000/);
  session=applyTennisAction({...session,config:{...session.config,focusSlug:'aec-cfb-a-b-2026-10-03'}},{action:'start',commandId:'go'},[],3000);
  assert.equal(session.status,'running');
  session=applyTennisAction(session,{action:'pause',commandId:'hold'},[],4000);
  assert.equal(session.status,'paused','Pause keeps the run');
  session=applyTennisAction(session,{action:'stop',commandId:'end'},[],5000);
  assert.equal(session.status,'stopped','End run with nothing held closes it at once');
});
