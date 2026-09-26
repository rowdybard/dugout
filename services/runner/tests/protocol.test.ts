import test from 'node:test';
import assert from 'node:assert/strict';
import {signRunnerRequest,verifyRunnerRequest,boundedBody} from '../../../lib/runner/protocol.ts';
import {encryptFeedCredentials,decryptFeedCredentials} from '../src/feed-credentials.ts';
import {OWNER,EPOCH,NOW,SECRET} from './helpers.ts';
const url='https://runner.invalid/v1/command?scope=paper',body='{"command":{"action":"pause"}}';
test('signed protocol verifies exact method, body, path/query, identity, epoch, nonce and time',async()=>{
  const headers=await signRunnerRequest(SECRET,url,'POST',body,OWNER,EPOCH,NOW,'nonce-fixture-0001');
  assert.equal((await verifyRunnerRequest(new Request(url,{method:'POST',body,headers}),SECRET,NOW)).owner,OWNER);
  const variants=[new Request(url+'x',{method:'POST',body,headers}),new Request(url,{method:'PUT',body,headers}),new Request(url,{method:'POST',body:body+' ',headers}),new Request(url,{method:'POST',body,headers:{...headers,'x-dugout-owner':OWNER+'x'}}),new Request(url,{method:'POST',body,headers:{...headers,'x-dugout-epoch':EPOCH+'x'}}),new Request(url,{method:'POST',body,headers:{...headers,'x-dugout-nonce':'nonce-fixture-0002'}})];
  for(const request of variants)await assert.rejects(()=>verifyRunnerRequest(request,SECRET,NOW),/Invalid or expired/);
  await assert.rejects(()=>verifyRunnerRequest(new Request(url,{method:'POST',body,headers}),SECRET,NOW+30001),/expired/);
});
test('missing authentication, weak secret and oversized or malformed bodies fail closed',async()=>{
  await assert.rejects(()=>verifyRunnerRequest(new Request(url),SECRET,NOW),/Invalid/);
  await assert.rejects(()=>signRunnerRequest('short',url,'POST',body,OWNER,EPOCH,NOW),/configuration/);
  await assert.rejects(()=>boundedBody(new Request(url,{method:'POST',body:'123456'}),5),/too large/);
  await assert.rejects(()=>boundedBody(new Request(url,{method:'POST',body:new Uint8Array([255])})),/encoded data/);
});
test('provider credentials are encrypted and bound to owner, epoch and signing secret',async()=>{
  const credentials={keyId:'synthetic-read-only',secretKey:btoa('x'.repeat(32))};
  const encrypted=await encryptFeedCredentials(credentials,SECRET,OWNER,EPOCH);
  assert.ok(!JSON.stringify(encrypted).includes(credentials.secretKey));assert.ok(!JSON.stringify(encrypted).includes(credentials.keyId));
  assert.deepEqual(await decryptFeedCredentials(encrypted,SECRET,OWNER,EPOCH),credentials);
  await assert.rejects(()=>decryptFeedCredentials(encrypted,SECRET,OWNER,EPOCH+'2'),/identity/);
  await assert.rejects(()=>decryptFeedCredentials(encrypted,SECRET+'wrong',OWNER,EPOCH),/could not be read/);
  await assert.rejects(()=>decryptFeedCredentials({...encrypted,ciphertext:encrypted.ciphertext.slice(0,-4)+'AAAA'},SECRET,OWNER,EPOCH),/could not be read/);
  assert.notEqual((await encryptFeedCredentials(credentials,SECRET,OWNER,EPOCH)).iv,encrypted.iv);
});
