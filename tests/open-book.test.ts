import test from 'node:test';
import assert from 'node:assert/strict';
import {openBook} from '../lib/tennis/open-book.ts';
import {purchaseAverageWithFees} from '../lib/tennis/position-average.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig} from '../lib/tennis/rules.ts';
import type {TennisIntent,TennisMarket,TennisPosition} from '../lib/tennis/types';

const NOW=Date.parse('2026-10-03T16:00:00Z');
const market=(slug:string,yes:string,no:string)=>({slug,yesName:yes,noName:no}) as TennisMarket;
const quote=(price:number,quantity:number)=>({price,quantity,placedAt:NOW,placedBookTime:NOW,activeAfter:NOW});

test('one list: offers on the main and Chaos games, and held shares with value if sold now',()=>{
  const session=createTennisSession({...defaultLiveTennisConfig(100),focusSlug:'a'},NOW);
  session.maker={slug:'a',quotes:{YES:quote(.7,7),NO:quote(.295,16)},pulledUntil:0,eventKey:null,lastBookTime:NOW,reason:'',fills:0,rebates:0};
  session.chaos={b:{slug:'b',quotes:{YES:quote(.4,12)},pulledUntil:0,eventKey:null,lastBookTime:NOW,reason:'',fills:1,rebates:0}};
  session.positions=[{id:'p',slug:'b',league:'CFB',title:'b',side:'NO',name:'Gamma',quantity:10,initialQuantity:10,costBasis:5.9,entryCost:5.9,entryPrice:.59,entryFees:0,
    openedAt:NOW,status:'open',realizedPnl:0,exitFees:0,proceeds:0,netLiquidationValue:6.2,liquidationQuantity:10,markedAt:NOW-1000,market:market('b','Beta','Gamma'),exitPolicy:'maker'} as TennisPosition];
  const book=openBook(session,[market('a','Liberty','Delaware'),market('b','Beta','Gamma')],NOW);
  assert.deepEqual(book.orders.map(o=>`${o.team} ${o.price} x${o.quantity} = ${o.reserved}`),['Liberty 0.7 x7 = 4.9','Delaware 0.295 x16 = 4.72','Beta 0.4 x12 = 4.8']);
  assert.equal(book.reserved,14.42);
  assert.equal(book.holdings.length,1);
  assert.deepEqual({team:book.holdings[0].team,result:book.holdings[0].result,policy:book.holdings[0].policy},{team:'Gamma',result:0.3,policy:'offer fill'});
  assert.equal(book.held,5.9);
  // A stale mark is not shown as a value.
  assert.equal(openBook(session,[],NOW+60_000).holdings[0].value,null);
});

const averagedPosition=():TennisPosition=>({id:'weighted',slug:'tennis',league:'WTA',title:'Tennis',side:'YES',name:'Player A',
  // Actual fills: 10 at 50 cents + 20 at 32 cents, with 43 cents total buy fees.
  quantity:30,initialQuantity:30,entryPrice:.38,entryFees:.43,entryCost:11.83,costBasis:11.83,
  openedAt:NOW,status:'open',realizedPnl:0,exitFees:0,proceeds:0,netLiquidationValue:12.3,liquidationQuantity:30,markedAt:NOW,
  market:market('tennis','Player A','Player B'),exitPolicy:'scalp'});

test('weighted purchase prices preserve the actual ex-fee average and fee-inclusive remaining cost',()=>{
  const session=createTennisSession(defaultLiveTennisConfig(100),NOW),position=averagedPosition();session.positions=[position];
  const holding=openBook(session,[],NOW).holdings[0];
  assert.equal(holding.averagePrice,.38);assert.equal(holding.averageWithFees,11.83/30);assert.equal(holding.cost,11.83);
  assert.equal(holding.result,.47);assert.equal(position.entryCost,11.83);assert.equal(position.entryFees,.43);
});

test('a partial sale retains purchase averages and a partial executable mark uses only its allocated basis',()=>{
  const session=createTennisSession(defaultLiveTennisConfig(100),NOW),position={...averagedPosition(),quantity:12,costBasis:4.732,
    proceeds:7.56,realizedPnl:.462,exitFees:.18,netLiquidationValue:1.28,liquidationQuantity:3};session.positions=[position];
  const holding=openBook(session,[],NOW).holdings[0];
  assert.equal(holding.quantity,12);assert.equal(holding.averagePrice,.38);assert.ok(Math.abs(holding.averageWithFees!-11.83/30)<1e-9);
  assert.equal(holding.cost,4.732);assert.equal(holding.value,1.28);assert.equal(holding.result,.097);assert.equal(holding.partial,true);
  assert.equal(position.initialQuantity,30);assert.equal(position.entryCost,11.83,'lifetime purchases are not divided by remaining shares');
  assert.equal(openBook(session,[],NOW+16_000).holdings[0].result,null);
});

test('a queued add buy is distinct from a new entry and cannot change current purchase averages',()=>{
  const session=createTennisSession(defaultLiveTennisConfig(100),NOW);session.positions=[averagedPosition()];
  session.pending={id:'add',positionId:'weighted',tennisAdd:true,slug:'tennis',market:session.positions[0].market,side:'YES',action:'BUY',limitPrice:.30,budget:7} as TennisIntent;
  const before=structuredClone(session),book=openBook(session,[],NOW);
  assert.equal(book.orders[0].kind,'queued-add');assert.equal(book.orders[0].reserved,7);assert.equal(book.reserved,7);
  assert.equal(book.holdings[0].averagePrice,.38);assert.equal(book.holdings[0].averageWithFees,11.83/30);assert.deepEqual(session,before);
  session.pending.tennisAdd=false;assert.equal(openBook(session,[],NOW).orders[0].kind,'queued-buy');
  session.pending.tennisAdd=true;session.pending.positionId='other';assert.equal(openBook(session,[],NOW).orders[0].kind,'queued-buy');
});

test('fee-inclusive purchase averages do not fabricate a value for invalid remaining quantity or basis',()=>{
  for(const position of [{quantity:0,costBasis:5},{quantity:NaN,costBasis:5},{quantity:10,costBasis:Infinity},{quantity:10,costBasis:-1}])assert.equal(purchaseAverageWithFees(position),null);
  assert.equal(purchaseAverageWithFees({quantity:10,costBasis:0}),0);
});
