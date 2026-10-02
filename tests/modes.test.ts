import test from 'node:test';
import assert from 'node:assert/strict';
import {boldSize,modeOf,modeRules,steadySize} from '../lib/tennis/modes.ts';
import {applyTennisAction,createTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig,validateTennisConfig} from '../lib/tennis/rules.ts';

test('Steady and Bold sizes stay inside the bot limits for every balance',()=>{
  assert.equal(steadySize(100),5);assert.equal(boldSize(100),12);
  assert.equal(boldSize(1000),50,'capped at $50: both sides fit the $100 exposure cap');
  for(const cash of [5,7,10,25,50,100,250,1000]){
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
