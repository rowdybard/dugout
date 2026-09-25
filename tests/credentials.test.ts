import test from 'node:test';
import assert from 'node:assert/strict';
import {verifyCredentials,polymarketSecrets} from '../lib/trading/credentials.ts';

const synthetic={POLYMARKET_KEY_ID:'synthetic-key-id',POLYMARKET_SECRET_KEY:btoa('x'.repeat(32))};
test('missing or malformed credentials never make an authenticated request',async()=>{
  let calls=0;const read=async()=>{calls++;return {balances:[]};};
  assert.equal((await verifyCredentials({},read)).state,'not_configured');
  assert.equal((await verifyCredentials({...synthetic,POLYMARKET_SECRET_KEY:'not-a-secret'},read)).state,'invalid_format');
  assert.equal(calls,0);
});
test('the existing key-ID alias works and the correctly named setting takes priority',()=>{
  assert.equal(polymarketSecrets({POLYNARKET_KEY_ID:'alias',POLYMARKET_SECRET_KEY:synthetic.POLYMARKET_SECRET_KEY})?.keyId,'alias');
  assert.equal(polymarketSecrets({...synthetic,POLYNARKET_KEY_ID:'alias'})?.keyId,'synthetic-key-id');
});
test('successful credential verification returns neither account data nor secret values',async()=>{
  const result=await verifyCredentials(synthetic,async received=>{
    assert.equal(received.keyId,synthetic.POLYMARKET_KEY_ID);
    return {balances:[{currentBalance:123456.78,currency:'USD',buyingPower:123456.78}]};
  },1234);
  assert.equal(result.state,'verified');assert.equal(result.liveEnabled,false);assert.equal(result.checkedAt,1234);
  const text=JSON.stringify(result);for(const value of [synthetic.POLYMARKET_KEY_ID,synthetic.POLYMARKET_SECRET_KEY,'123456.78','balances'])assert.equal(text.includes(value),false);
});
test('provider error text cannot leak keys, balances or signing information',async()=>{
  for(const status of [401,403,429,500]){
    const result=await verifyCredentials(synthetic,async()=>{throw Object.assign(new Error(JSON.stringify(synthetic)),{status});});
    assert.equal(result.liveEnabled,false);assert.equal(result.state,status===401||status===403?'rejected':'unavailable');
    assert.equal(JSON.stringify(result).includes(synthetic.POLYMARKET_SECRET_KEY),false);assert.equal(JSON.stringify(result).includes('synthetic-key-id'),false);
  }
});
test('an unexpected account response never becomes a verified connection',async()=>{
  assert.equal((await verifyCredentials(synthetic,async()=>({ok:true}))).state,'unavailable');
});
