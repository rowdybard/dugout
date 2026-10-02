/**
 * Self-hosting on Cloudflare (docs/CLOUDFLARE-HOSTING.md). Cloudflare Access sits in front of the Worker and does
 * the invite list, the sign-in (an emailed code, or Google) and the remembered-device session. The Worker verifies
 * Access's signed token on every request and turns it into the identity headers the app already reads
 * (`oai-authenticated-user-*`, the Sites convention). A header a visitor sends is never trusted: without a valid
 * token the request is refused, so the workers.dev address is safe even where Access is not switched on.
 */

export type AccessEnv={ACCESS_TEAM_DOMAIN?:string;ACCESS_AUD?:string};
export type AccessConfig={teamDomain:string;audience:string};
export type AccessIdentity={userId:string;email:string};
type Deps={now?:number;fetcher?:typeof fetch};

const IDENTITY_HEADER_PREFIX='oai-authenticated-';
const KEY_TTL_MS=60*60_000,REFETCH_GAP_MS=60_000,CLOCK_SKEW_S=60;

export function accessConfig(env:AccessEnv):AccessConfig|null {
  const teamDomain=(env.ACCESS_TEAM_DOMAIN??'').trim().toLowerCase().replace(/^https:\/\//,'').replace(/\/+$/,'');
  const audience=(env.ACCESS_AUD??'').trim().toLowerCase();
  if(!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/.test(teamDomain)||!/^[a-f0-9]{32,128}$/.test(audience))return null;
  return {teamDomain,audience};
}

/** A stable, non-reversible account id per email address (the same person gets the same paper account on any device). */
export async function userIdForEmail(email:string):Promise<string> {
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(`dugout-user:${email.trim().toLowerCase()}`));
  return `u_${[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,'0')).join('').slice(0,40)}`;
}

function base64url(value:string):Uint8Array<ArrayBuffer> {
  if(!/^[A-Za-z0-9_-]*$/.test(value))throw new Error('bad encoding');
  const text=atob(value.replace(/-/g,'+').replace(/_/g,'/')+'='.repeat((4-value.length%4)%4));
  return Uint8Array.from(text,char=>char.charCodeAt(0));
}
const json=(part:string)=>JSON.parse(new TextDecoder().decode(base64url(part))) as Record<string,unknown>;

type KeySet={keys:Map<string,CryptoKey>;fetchedAt:number};
const keyCache=new Map<string,KeySet>();

async function loadKeys(teamDomain:string,fetcher:typeof fetch,now:number):Promise<KeySet> {
  // Workers' fetch accepts only 'follow' or 'manual' ('error' throws); a redirect comes back non-OK and is refused below.
  const response=await fetcher(`https://${teamDomain}/cdn-cgi/access/certs`,{redirect:'manual'});
  if(!response.ok)throw new Error(`Access keys unavailable (${response.status}).`);
  const body=await response.json() as {keys?:(JsonWebKey&{kid?:string})[]};
  const keys=new Map<string,CryptoKey>();
  for(const jwk of body.keys??[]){
    if(jwk.kty!=='RSA'||typeof jwk.kid!=='string')continue;
    keys.set(jwk.kid,await crypto.subtle.importKey('jwk',{kty:'RSA',n:jwk.n,e:jwk.e,alg:'RS256',ext:true},{name:'RSASSA-PKCS1-v1_5',hash:'SHA-256'},false,['verify']));
  }
  const set={keys,fetchedAt:now};keyCache.set(teamDomain,set);
  return set;
}

async function keyFor(config:AccessConfig,kid:string,fetcher:typeof fetch,now:number):Promise<CryptoKey|null> {
  let set=keyCache.get(config.teamDomain);
  if(!set||now-set.fetchedAt>KEY_TTL_MS)set=await loadKeys(config.teamDomain,fetcher,now);
  // Access rotates keys: an unknown key id triggers one refetch, at most once a minute.
  if(!set.keys.has(kid)&&now-set.fetchedAt>REFETCH_GAP_MS)set=await loadKeys(config.teamDomain,fetcher,now);
  return set.keys.get(kid)??null;
}

/** Verify an Access application token: RS256 signature from the team's keys, audience, issuer and expiry. */
export async function verifyAccessToken(token:string,config:AccessConfig,{now=Date.now(),fetcher=fetch}:Deps={}):Promise<AccessIdentity|{error:string}> {
  const parts=token.split('.');
  if(parts.length!==3||token.length>16_384)return {error:'Malformed sign-in token.'};
  let header:Record<string,unknown>,payload:Record<string,unknown>,signature:Uint8Array<ArrayBuffer>;
  try{header=json(parts[0]);payload=json(parts[1]);signature=base64url(parts[2]);}catch{return {error:'Malformed sign-in token.'};}
  if(header.alg!=='RS256'||typeof header.kid!=='string')return {error:'Unsupported sign-in token.'};
  const seconds=now/1000,audiences=Array.isArray(payload.aud)?payload.aud:[payload.aud];
  if(!audiences.includes(config.audience))return {error:'The sign-in token is for another application.'};
  if(payload.iss!==`https://${config.teamDomain}`)return {error:'The sign-in token has the wrong issuer.'};
  if(typeof payload.exp!=='number'||payload.exp<=seconds)return {error:'The sign-in has expired.'};
  if(typeof payload.nbf==='number'&&payload.nbf>seconds+CLOCK_SKEW_S)return {error:'The sign-in token is not valid yet.'};
  const email=typeof payload.email==='string'?payload.email.trim().toLowerCase():'';
  if(!/^[^\s@]+@[^\s@]+$/.test(email)||email.length>320)return {error:'The sign-in token has no email address.'};
  let key:CryptoKey|null;
  try{key=await keyFor(config,header.kid,fetcher,now);}catch{return {error:'Sign-in keys are unavailable. Try again shortly.'};}
  if(!key)return {error:'The sign-in token was signed by an unknown key.'};
  const valid=await crypto.subtle.verify('RSASSA-PKCS1-v1_5',key,signature,new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if(!valid)return {error:'The sign-in token signature is invalid.'};
  return {userId:await userIdForEmail(email),email};
}

export function accessToken(request:Request):string|null {
  const header=request.headers.get('cf-access-jwt-assertion');
  if(header)return header.trim();
  const cookie=(request.headers.get('cookie')??'').split(';').map(item=>item.trim()).find(item=>item.startsWith('CF_Authorization='));
  return cookie?cookie.slice('CF_Authorization='.length):null;
}

function refuse(status:number,message:string):Response {
  const body=`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Dugout</title>`+
    `<body style="margin:0;min-height:100vh;display:grid;place-items:center;background:#0d1117;color:#eef2f6;font:16px/1.5 system-ui,sans-serif">`+
    `<main style="max-width:420px;padding:24px;text-align:center"><h1 style="font-size:24px">Dugout is invite-only</h1><p>${message}</p></main></body>`;
  return new Response(body,{status,headers:{'content-type':'text/html; charset=utf-8','cache-control':'no-store'}});
}

/**
 * The request the app should see (identity headers set from the verified token, anything a visitor sent removed),
 * or the refusal to send back. Fails closed when Access is not configured.
 */
export async function withAccessIdentity(request:Request,env:AccessEnv,deps:Deps={}):Promise<Request|Response> {
  const config=accessConfig(env);
  if(!config)return refuse(503,'Sign-in is not configured on this server yet.');
  const token=accessToken(request);
  if(!token)return refuse(401,'Open Dugout from the address you were invited to and sign in.');
  const identity=await verifyAccessToken(token,config,deps);
  if('error' in identity)return refuse(403,`${identity.error} Open Dugout from your invite link to sign in again.`);
  const headers=new Headers(request.headers);
  for(const name of [...headers.keys()])if(name.toLowerCase().startsWith(IDENTITY_HEADER_PREFIX))headers.delete(name);
  headers.set('oai-authenticated-user-id',identity.userId);
  headers.set('oai-authenticated-user-email',identity.email);
  return new Request(request,{headers});
}

/** Test hook: forget cached keys. */
export function clearAccessKeyCache(){keyCache.clear();}
