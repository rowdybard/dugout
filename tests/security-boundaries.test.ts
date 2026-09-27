import test from 'node:test';
import assert from 'node:assert/strict';
import {registerHooks} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {streamOwnerIssue} from '../lib/server/owner-access.ts';
import {runnerError} from '../lib/runner/protocol.ts';

const root=fileURLToPath(new URL('../',import.meta.url));
const hooks=registerHooks({resolve(specifier,context,next){
  if(specifier==='cloudflare:workers')return {url:'data:text/javascript,export const env={}',shortCircuit:true};
  if(specifier.startsWith('@/'))return {url:pathToFileURL(resolve(root,specifier.slice(2)+'.ts')).href,shortCircuit:true};
  return next(specifier,context);
}});
const {requireUserId,sameOrigin}=await import('../lib/server/storage.ts');
hooks.deregister();

const OWNER='owner_1234567890';
const req=(method:string,headers:Record<string,string>)=>new Request('https://dugout.example/api/tennis/session',{method,headers,...(method==='POST'?{body:'{}'}:{})});

test('identity: the signed-in header is required; there is no shared fallback account',()=>{
  assert.equal(requireUserId(req('GET',{'oai-authenticated-user-id':OWNER})),OWNER);
  for(const headers of [{},{'oai-authenticated-user-id':''},{'oai-authenticated-user-id':'private owner'},{'oai-authenticated-user-id':'short'},{'x-dugout-owner':OWNER}] as Record<string,string>[])
    assert.throws(()=>requireUserId(req('GET',headers)),/Sign in/);
  // Route error mapping turns it into a 401 with the sign-in message, not a generic 500.
  let error:unknown;try{requireUserId(req('GET',{}));}catch(caught){error=caught;}
  const response=runnerError(error);
  assert.equal(response.status,401);
});

test('origin: state-changing requests must prove they come from this site',()=>{
  const same='https://dugout.example';
  assert.doesNotThrow(()=>sameOrigin(req('POST',{origin:same})));
  assert.doesNotThrow(()=>sameOrigin(req('POST',{'sec-fetch-site':'same-origin'})));
  assert.doesNotThrow(()=>sameOrigin(req('GET',{})),'safe methods need no Origin');
  assert.throws(()=>sameOrigin(req('POST',{})),/origin mismatch/,'no Origin and no browser attestation');
  assert.throws(()=>sameOrigin(req('POST',{origin:'https://evil.example'})),/origin mismatch/);
  assert.throws(()=>sameOrigin(req('POST',{origin:same,'sec-fetch-site':'cross-site'})),/origin mismatch/);
  assert.throws(()=>sameOrigin(req('POST',{'sec-fetch-site':'cross-site'})),/origin mismatch/);
  assert.throws(()=>sameOrigin(req('DELETE',{'sec-fetch-site':'same-site'})),/origin mismatch/);
});

test("streams: only the pinned owner may use the owner's Polymarket key",async()=>{
  const env={DUGOUT_OWNER_ID:OWNER};
  assert.equal(streamOwnerIssue(req('GET',{'oai-authenticated-user-id':OWNER}),env),null);
  for(const [headers,pinned] of [[{'oai-authenticated-user-id':'guest_1234567890'},env],[{},env],[{'oai-authenticated-user-id':OWNER},{}]] as const){
    const denied=streamOwnerIssue(req('GET',headers),pinned);
    assert.equal(denied?.status,403);assert.match((await denied!.json() as {error:string}).error,/REST/);
  }
});
