import test from 'node:test';
import assert from 'node:assert/strict';
import {ownerIdFor} from '../scripts/cloudflare-hosting.mjs';
import {accessConfig,accessToken,clearAccessKeyCache,userIdForEmail,verifyAccessToken,withAccessIdentity} from '../lib/server/cloudflare-access.ts';

const TEAM='dugout-test.cloudflareaccess.com',AUD='a'.repeat(64),NOW=Date.parse('2026-09-27T18:00:00Z');
const env={ACCESS_TEAM_DOMAIN:TEAM,ACCESS_AUD:AUD};
const encode=(value:unknown)=>Buffer.from(typeof value==='string'?value:JSON.stringify(value)).toString('base64url');

const pair=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const other=await crypto.subtle.generateKey({name:'RSASSA-PKCS1-v1_5',modulusLength:2048,publicExponent:new Uint8Array([1,0,1]),hash:'SHA-256'},true,['sign','verify']);
const jwk={...await crypto.subtle.exportKey('jwk',pair.publicKey),kid:'key-1'};

function certs(){
  const calls:string[]=[];
  const fetcher=(async(url:string,init?:RequestInit)=>{
    // Cloudflare Workers reject redirect:'error' (only 'follow' or 'manual'), which broke every sign-in.
    assert.equal(init?.redirect,'manual');calls.push(url);return Response.json({keys:[jwk]});}) as unknown as typeof fetch;
  return {calls,fetcher};
}
async function token(claims:Record<string,unknown>={},header:Record<string,unknown>={alg:'RS256',kid:'key-1'},key=pair.privateKey){
  const body={aud:[AUD],iss:`https://${TEAM}`,email:'Friend@Example.com',sub:'1234',exp:NOW/1000+3600,iat:NOW/1000,nbf:NOW/1000,type:'app',...claims};
  const signing=`${encode(header)}.${encode(body)}`;
  const signature=await crypto.subtle.sign('RSASSA-PKCS1-v1_5',key,new TextEncoder().encode(signing));
  return `${signing}.${Buffer.from(signature).toString('base64url')}`;
}

test('a valid Access token becomes a stable account id per email, accepted by the app',async()=>{
  clearAccessKeyCache();
  const {calls,fetcher}=certs();
  const identity=await verifyAccessToken(await token(),accessConfig(env)!,{now:NOW,fetcher});
  assert.ok(!('error' in identity),JSON.stringify(identity));
  assert.equal(identity.email,'friend@example.com');
  assert.equal(identity.userId,await userIdForEmail(' FRIEND@example.com '));
  assert.match(identity.userId,/^u_[0-9a-f]{40}$/);
  // The account-id rule in lib/server/storage.ts requireUserId and lib/runner/sites-proxy.ts requireSitesOwner.
  assert.match(identity.userId,/^[a-zA-Z0-9_-]{8,160}$/);
  assert.deepEqual(calls,[`https://${TEAM}/cdn-cgi/access/certs`]);
  await verifyAccessToken(await token(),accessConfig(env)!,{now:NOW+1000,fetcher});
  assert.equal(calls.length,1,'keys are cached');
  assert.notEqual(await userIdForEmail('a@example.com'),await userIdForEmail('b@example.com'));
});

test('forged, foreign, expired and malformed tokens are refused',async()=>{
  clearAccessKeyCache();
  const {calls,fetcher}=certs(),config=accessConfig(env)!;
  const refused=async(value:string,pattern:RegExp)=>{const result=await verifyAccessToken(value,config,{now:NOW,fetcher});assert.ok('error' in result&&pattern.test(result.error),`${JSON.stringify(result)} vs ${pattern}`);};
  await refused(await token({aud:['b'.repeat(64)]}),/another application/);
  await refused(await token({iss:'https://evil.cloudflareaccess.com'}),/issuer/);
  await refused(await token({exp:NOW/1000-1}),/expired/);
  await refused(await token({nbf:NOW/1000+3600}),/not valid yet/);
  await refused(await token({email:undefined}),/no email/);
  await refused(await token({},{alg:'none',kid:'key-1'}),/Unsupported/);
  await refused(await token({},{alg:'HS256',kid:'key-1'}),/Unsupported/);
  await refused(await token({},undefined,other.privateKey),/signature is invalid/);
  const good=await token(),[h,,s]=good.split('.');
  await refused(`${h}.${encode({aud:[AUD],iss:`https://${TEAM}`,email:'owner@example.com',exp:NOW/1000+3600})}.${s}`,/signature is invalid/);
  await refused('not.a.token',/Malformed/);await refused('abc',/Malformed/);
  // An unknown key id refetches (keys rotate), at most once a minute, then refuses.
  const before=calls.length,rotated=await token({},{alg:'RS256',kid:'rotated'});
  await refused(rotated,/unknown key/);
  assert.equal(calls.length,before,'no refetch within a minute of the last one');
  const later=await verifyAccessToken(rotated,config,{now:NOW+61_000,fetcher});
  assert.ok('error' in later&&/unknown key/.test(later.error));
  assert.equal(calls.length,before+1);
  const down=(async()=>new Response('no',{status:500})) as unknown as typeof fetch;
  clearAccessKeyCache();
  const result=await verifyAccessToken(await token(),config,{now:NOW,fetcher:down});
  assert.ok('error' in result&&/unavailable/.test(result.error));
});

test('the Worker wrapper sets verified identity, strips anything a visitor sent, and fails closed',async()=>{
  clearAccessKeyCache();
  const {fetcher}=certs();
  const signed=await token();
  const spoofed=new Request('https://dugout.example.workers.dev/api/tennis/session',{method:'POST',body:'{}',
    headers:{'cf-access-jwt-assertion':signed,'oai-authenticated-user-id':'private-owner-id','OAI-Authenticated-User-Full-Name':'Owner','content-type':'application/json'}});
  const passed=await withAccessIdentity(spoofed,env,{now:NOW,fetcher});
  assert.ok(passed instanceof Request);
  assert.equal(passed.headers.get('oai-authenticated-user-id'),await userIdForEmail('friend@example.com'));
  assert.equal(passed.headers.get('oai-authenticated-user-email'),'friend@example.com');
  assert.equal(passed.headers.get('oai-authenticated-user-full-name'),null);
  assert.equal(passed.method,'POST');assert.equal(await passed.text(),'{}');
  // The Access cookie works when the header is absent.
  const cookie=new Request('https://dugout.example/',{headers:{cookie:`theme=dark; CF_Authorization=${signed}`}});
  assert.equal(accessToken(cookie),signed);
  assert.ok(await withAccessIdentity(cookie,env,{now:NOW,fetcher}) instanceof Request);
  // No token, bad token, or no configuration: refused before the app runs.
  const anonymous=await withAccessIdentity(new Request('https://dugout.example/',{headers:{'oai-authenticated-user-id':'private-owner-id'}}),env,{now:NOW,fetcher});
  assert.ok(anonymous instanceof Response);assert.equal(anonymous.status,401);assert.match(await anonymous.text(),/invite-only/);
  const forged=await withAccessIdentity(new Request('https://dugout.example/',{headers:{'cf-access-jwt-assertion':'x.y.z'}}),env,{now:NOW,fetcher});
  assert.ok(forged instanceof Response&&forged.status===403);
  const unconfigured=await withAccessIdentity(new Request('https://dugout.example/',{headers:{'cf-access-jwt-assertion':signed}}),{},{now:NOW,fetcher});
  assert.ok(unconfigured instanceof Response&&unconfigured.status===503);
});

test('Access configuration is validated',()=>{
  assert.deepEqual(accessConfig({ACCESS_TEAM_DOMAIN:'https://Dugout-Test.cloudflareaccess.com/',ACCESS_AUD:AUD.toUpperCase()}),{teamDomain:TEAM,audience:AUD});
  for(const bad of [{},{ACCESS_TEAM_DOMAIN:TEAM},{ACCESS_AUD:AUD},{ACCESS_TEAM_DOMAIN:'evil.com',ACCESS_AUD:AUD},{ACCESS_TEAM_DOMAIN:TEAM,ACCESS_AUD:'not-hex'}])
    assert.equal(accessConfig(bad),null,JSON.stringify(bad));
});

test('the setup script computes the same account id as the Worker (for DUGOUT_OWNER_ID and RUNNER_OWNER_ID)',async()=>{
  for(const email of ['Owner@Example.com',' friend@example.com '])assert.equal(ownerIdFor(email),await userIdForEmail(email));
});
