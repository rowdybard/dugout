import test from 'node:test';
import assert from 'node:assert/strict';
import {simulateBuy,simulateSell,feeFor,sideBook} from '../lib/market/paper.ts';
import {scan,DEFAULT_CONFIG,activitySignals} from '../lib/market/scanner.ts';
import type {Book,Market} from '../lib/market/types.ts';
const book:Book={bids:[{price:.38,quantity:100}],asks:[{price:.4,quantity:10},{price:.45,quantity:100}],state:'MARKET_STATE_OPEN',time:new Date().toISOString()};
test('walks asks and includes fees without overspending',()=>{const f=simulateBuy(book,10);assert(f.contracts>10);assert(f.average>.4);assert(f.total<=10);assert(f.fees>0);assert(Math.abs(f.total+f.unused-10)<1e-8);});
test('40 cent example buys 25 contracts without fees, fewer with fees',()=>{const b={...book,asks:[{price:.4,quantity:100}]};assert.equal(simulateBuy(b,10,0).contracts,25);assert.equal(simulateBuy(b,10).contracts,23);});
test('thin book cannot invent fills',()=>{assert.equal(simulateBuy({...book,asks:[]},25).contracts,0);assert.equal(simulateBuy({...book,asks:[{price:.4,quantity:3}]},25).contracts,3);assert.equal(simulateSell({...book,bids:[]},10).complete,false);});
test('exit pays bid less fees, never ask',()=>{const s=simulateSell(book,10);assert.equal(s.complete,true);assert(Math.abs(s.net-(3.8-feeFor(10,.38)))<1e-8);});
test('positive and negative signals derive from history and configurable thresholds',()=>{const now=Date.now();const m={history:[{time:now-3590000,price:.36},{time:now-1800000,price:.4},{time:now,price:.43}],bid:.42,ask:.44} as Market;assert.equal(scan(m)[0].type,'PRICE MOVING');assert.equal(scan(m,{...DEFAULT_CONFIG,move:10}).length,0);m.history=m.history.map(p=>({...p,price:1-p.price}));assert.equal(scan(m)[0].type,'PRICE DROPPING');});
test('missing data is not manufactured into zero prices or activity',()=>{assert.deepEqual(scan({history:[],bid:null,ask:null} as unknown as Market),[]);assert.deepEqual(activitySignals([],DEFAULT_CONFIG),[]);});

test('NO price transformation preserves spread and executable sides',()=>{const no=sideBook(book,'NO');assert(Math.abs(no.asks[0].price-.62)<1e-9);assert(Math.abs(no.bids[0].price-.6)<1e-9);assert(simulateBuy(no,10).contracts>0);});
