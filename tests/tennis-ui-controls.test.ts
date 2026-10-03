import test from 'node:test';
import assert from 'node:assert/strict';
import {botAction,botQuery,supportsBot,tennisStrategyRules,walletHasOrders,walletNeedsCheck} from '../components/tennis/bot-controls.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig,defaultTennisBotConfig} from '../lib/tennis/rules.ts';
import type {TennisRuntime,TennisSession} from '../lib/tennis/types';

const runtime=(patch:Partial<TennisRuntime>={}):TennisRuntime=>({mode:'service',intervalMs:2500,backgroundConnected:true,streamConfigured:true,description:'Runner',...patch});
const account=()=>createTennisSession(defaultLiveTennisConfig(100),1000);
const withTennis=(full:TennisSession,status:TennisSession['status'])=>({...full,bots:{tennis:{...createTennisSession(defaultTennisBotConfig(100),1000),status}}});

test('Tennis controls wait for runner support while legacy Football controls remain available',()=>{
  assert.equal(supportsBot(null,'tennis'),false);
  assert.equal(supportsBot(runtime(),'football'),true);
  assert.equal(supportsBot(runtime(),'tennis'),false);
  assert.equal(supportsBot(runtime({supportedBots:['football']}),'tennis'),false);
  assert.equal(supportsBot(runtime({supportedBots:['football','tennis']}),'tennis'),true);
  assert.equal(supportsBot(runtime({mode:'migrating',supportedBots:['football','tennis']}),'tennis'),false);
  assert.equal(supportsBot(runtime({mode:'browser'}),'tennis'),true);
});

test('switching fixed Tennis strategies to Auto authorizes both signal experiments',()=>{
  const fixed=defaultTennisBotConfig(100,'recovery');
  assert.deepEqual(fixed.explore,['tennis-recovery']);
  const automatic={...fixed,...tennisStrategyRules('auto')};
  assert.equal(automatic.tennisStrategy,'auto');assert.equal(automatic.strategy,'auto');
  assert.deepEqual(automatic.explore,['tennis-recovery','tennis-momentum']);
  assert.deepEqual(tennisStrategyRules('momentum').explore,['tennis-momentum']);
});

test('independent commands target their bot, but reset/liquidation/checks address the shared wallet',()=>{
  assert.deepEqual(botAction({action:'pause',commandId:'pause'},'tennis'),{action:'pause',commandId:'pause',botId:'tennis'});
  assert.deepEqual(botAction({action:'pause',commandId:'pause'},'football',runtime()),{action:'pause',commandId:'pause'});
  assert.equal(botAction({action:'pause',commandId:'pause'},'football',runtime({supportedBots:['football','tennis']})).botId,'football');
  for(const action of [{action:'reset',bankroll:100,commandId:'reset'},{action:'exit-now',commandId:'exit'},{action:'tick',sessionId:'wallet'}] as const){
    const scoped={...action,botId:'tennis' as const};
    assert.deepEqual(botAction(scoped,'tennis'),action);
    assert.equal(scoped.botId,'tennis');
  }
  assert.equal(botQuery('/api/tennis','tennis'),'/api/tennis?botId=tennis');
  assert.equal(botQuery('/api/tennis/book?slug=atp-test','tennis'),'/api/tennis/book?slug=atp-test&botId=tennis');
});

test('an idle Football tab still schedules checks for the independent running or exiting Tennis bot',()=>{
  const full=account();assert.equal(walletNeedsCheck(full),false);
  for(const status of ['running','paused','stopping'] as const){
    const shared=withTennis(full,status);assert.equal(shared.status,'idle');assert.equal(walletNeedsCheck(shared),true);
  }
  assert.equal(walletNeedsCheck(withTennis(full,'stopped')),false);
  const pending=withTennis(full,'idle');pending.bots.tennis.pending={id:'buy',action:'BUY'} as NonNullable<TennisSession['pending']>;
  assert.equal(walletNeedsCheck(pending),true);assert.equal(walletHasOrders(pending),true);
  assert.equal(walletHasOrders(full),false);
});
