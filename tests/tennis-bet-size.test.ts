import test from 'node:test';
import assert from 'node:assert/strict';
import {defaultTennisBotConfig,defaultLiveTennisConfig,tennisBetSize,validateTennisConfig} from '../lib/tennis/rules.ts';
import {tennisBetOptions} from '../components/tennis/bot-controls.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
import {accountBotView,applyAccountAction} from '../lib/tennis/account.ts';

test('new Tennis defaults scale ten percent, respect the existing cap and permit the smallest account',()=>{
  for(const [balance,expected] of [[5,1],[50,5],[100,10],[500,50],[1000,100],[10000,100]]){
    const config=defaultTennisBotConfig(balance);
    assert.equal(config.entryBudget,expected);
    assert.equal(validateTennisConfig(config),null);
    for(const option of tennisBetOptions(balance))assert.ok(option.budget<=Math.min(100,balance*.2));
    assert.equal(new Set(tennisBetOptions(balance).map(option=>option.budget)).size,tennisBetOptions(balance).length);
  }
  assert.equal(tennisBetSize(100,.2),20);
  assert.equal(defaultLiveTennisConfig(100).entryBudget,5);
  for(const balance of [5.000003,10.000003,499.999999])for(const option of tennisBetOptions(balance)){
    assert.ok(option.budget<=Math.min(100,balance*.2));
    assert.equal(validateTennisConfig({...defaultTennisBotConfig(balance),entryBudget:option.budget}),null);
  }
});

test('changing an existing Tennis bet records the change without resetting the wallet or altering Football',()=>{
  const original=createTennisSession(defaultLiveTennisConfig(100),1000);
  const account=applyAccountAction(original,{action:'start',botId:'tennis',commandId:'start-sizing',config:{entryBudget:5}},[],2000);
  account.cash=95;
  const before=structuredClone(account),tennis=accountBotView(account,'tennis');
  assert.equal(tennis.config.entryBudget,5,'saved bets are never silently overwritten by a new default');
  const changed=applyAccountAction(account,{action:'update-rules',botId:'tennis',sessionId:account.id,expectedRulesRevision:tennis.rulesRevision??0,commandId:'bet-ten',rules:{entryBudget:10}},[],3000);
  assert.equal(changed.bots?.tennis?.config.entryBudget,10);
  assert.equal(changed.bots?.tennis?.status,'running');
  assert.equal(changed.cash,before.cash);
  assert.equal(changed.id,before.id);
  assert.deepEqual(changed.config,before.config);
  assert.deepEqual(changed.positions,before.positions);
  assert.deepEqual(changed.ledger,before.ledger);
  assert.ok(changed.decisions.some(row=>row.botId==='tennis'&&row.code==='RULES_UPDATED'));
});
