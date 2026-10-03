import test from 'node:test';
import assert from 'node:assert/strict';
import {openBook} from '../lib/tennis/open-book.ts';
import {createTennisSession} from '../lib/tennis/engine.ts';
import {defaultLiveTennisConfig} from '../lib/tennis/rules.ts';
import type {TennisMarket,TennisPosition} from '../lib/tennis/types';

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
  // An old mark still counts (as in the balance), and says how old it is.
  const old=openBook(session,[],NOW+60_000).holdings[0];
  assert.equal(old.value,6.2);assert.equal(old.price,'old');assert.equal(old.priceNote,'price 61 s old');
});
