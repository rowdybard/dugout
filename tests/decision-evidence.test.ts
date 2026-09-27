import test from 'node:test';
import assert from 'node:assert/strict';
import {decisionEvidence} from '../lib/tennis/decision-evidence.ts';
import {createTennisSession,defaultTennisConfig} from '../lib/tennis/engine.ts';
import {analyzeOpportunity} from '../lib/tennis/opportunity.ts';
import type {TennisDecision} from '../lib/tennis/types';

const analysis=analyzeOpportunity({history:[],book:{bids:[],asks:[],state:'MARKET_STATE_OPEN',time:new Date(1000).toISOString()},
  market:{slug:'a',league:'ATP',active:true,minimumTradeQty:1,quantityIncrement:1,priceIncrement:.01,feeCoefficient:.05},
  side:'YES',now:1000,bookReceivedAt:1000,bookSource:'REST',budget:5,cash:100,executionDelayMs:1000});
const decision=(id:string,slug:string,side:'YES'|'NO',time:number):TennisDecision=>({id,slug,side,time,action:'WAIT',code:'TEST',reason:'Synthetic analysis',analysis});

test('decision detail never substitutes a newer analysis from another game or outcome',()=>{
  const session=createTennisSession(defaultTennisConfig(),1000);
  session.decisions=[decision('a-yes','a','YES',2000),decision('a-no','a','NO',3000),decision('b','b','YES',4000)];
  assert.equal(decisionEvidence(session,'a','YES')?.time,2000);
  assert.equal(decisionEvidence(session,'a')?.time,3000);
  assert.equal(decisionEvidence(session,'missing'),null);
  assert.equal(decisionEvidence(session,null),null);
});

test('unmeasured legacy decisions remain absent instead of acquiring quantitative metrics',()=>{
  const session=createTennisSession(defaultTennisConfig(),1000);
  session.decisions=[{id:'legacy',slug:'a',side:'YES',time:2000,action:'WAIT',code:'NO_DIP',reason:'Legacy pattern'}];
  assert.equal(decisionEvidence(session,'a'),null);
  assert.equal(JSON.stringify(analysis).includes('NaN'),false);
});
