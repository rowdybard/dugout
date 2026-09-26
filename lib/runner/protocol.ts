import {RUNNER_PROTOCOL} from './contracts.ts';
const encoder=new TextEncoder();
export const MAX_REQUEST_BYTES=1_000_000;
export const MAX_SKEW_MS=30_000;
export type VerifiedRequest={owner:string;epoch:string;nonce:string;timestamp:number;body:string;path:string};
type SignableRequest=Pick<Request,'headers'|'body'|'method'|'url'>;
export class RunnerError extends Error {status:number;constructor(status:number,message:string){super(message);this.status=status;}}
export const hex=(bytes:Uint8Array)=>Array.from(bytes,b=>b.toString(16).padStart(2,'0')).join('');
export async function sha256(value:string):Promise<string>{return hex(new Uint8Array(await crypto.subtle.digest('SHA-256',encoder.encode(value))));}
const safeId=(value:string)=>/^[a-zA-Z0-9_-]{8,160}$/.test(value);
function canonical(method:string,path:string,hash:string,owner:string,timestamp:string,nonce:string,epoch:string){
  return [RUNNER_PROTOCOL,method,path,hash,owner,timestamp,nonce,epoch].join('\n');
}
const base64url=(bytes:Uint8Array)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function key(secret:string){if(typeof secret!=='string'||secret.length<32)throw new RunnerError(503,'Runner signing configuration is unavailable.');return crypto.subtle.importKey('raw',encoder.encode(secret),{name:'HMAC',hash:'SHA-256'},false,['sign','verify']);}
export async function signRunnerRequest(secret:string,url:string,method:string,body:string,owner:string,epoch:string,now=Date.now(),nonce=crypto.randomUUID()){
  if(!safeId(owner)||!safeId(epoch)||!safeId(nonce)||!Number.isSafeInteger(now))throw new Error('Invalid runner signing identity.');
  const parsed=new URL(url),timestamp=String(now);
  const text=canonical(method.toUpperCase(),parsed.pathname+parsed.search,await sha256(body),owner,timestamp,nonce,epoch);
  return {'x-dugout-owner':owner,'x-dugout-epoch':epoch,'x-dugout-timestamp':timestamp,'x-dugout-nonce':nonce,
    'x-dugout-signature':base64url(new Uint8Array(await crypto.subtle.sign('HMAC',await key(secret),encoder.encode(text))))};
}
export async function boundedBody(request:Pick<Request,'headers'|'body'>,max=MAX_REQUEST_BYTES):Promise<string>{
  if(Number(request.headers.get('content-length'))>max)throw new RunnerError(413,'Runner request is too large.');
  if(!request.body)return '';
  const reader=request.body.getReader(),decoder=new TextDecoder('utf-8',{fatal:true});let size=0,body='';
  try{while(true){const item=await reader.read();if(item.done)break;size+=item.value.byteLength;if(size>max)throw new RunnerError(413,'Runner request is too large.');body+=decoder.decode(item.value,{stream:true});}return body+decoder.decode();}
  catch(error){await reader.cancel().catch(()=>{});throw error;}finally{reader.releaseLock();}
}
export async function verifyRunnerRequest(request:SignableRequest,secret:string,now=Date.now()):Promise<VerifiedRequest>{
  const owner=request.headers.get('x-dugout-owner')??'',epoch=request.headers.get('x-dugout-epoch')??'',nonce=request.headers.get('x-dugout-nonce')??'';
  const timestampText=request.headers.get('x-dugout-timestamp')??'',signature=request.headers.get('x-dugout-signature')??'';
  const timestamp=Number(timestampText),url=new URL(request.url),path=url.pathname+url.search;
  if(!safeId(owner)||!safeId(epoch)||!safeId(nonce)||!/^\d{13}$/.test(timestampText)||!Number.isSafeInteger(timestamp)||Math.abs(now-timestamp)>MAX_SKEW_MS||!/^[A-Za-z0-9_-]{43}$/.test(signature))throw new RunnerError(401,'Invalid or expired runner request.');
  const body=await boundedBody(request);
  const bytes=Uint8Array.from(atob(signature.replace(/-/g,'+').replace(/_/g,'/')+'='),c=>c.charCodeAt(0));
  const valid=await crypto.subtle.verify('HMAC',await key(secret),bytes,encoder.encode(canonical(request.method,path,await sha256(body),owner,timestampText,nonce,epoch)));
  if(!valid)throw new RunnerError(401,'Invalid or expired runner request.');
  return {owner,epoch,nonce,timestamp,body,path};
}
export function json<T>(body:string):T {try{return JSON.parse(body) as T;}catch{throw new RunnerError(400,'Invalid JSON request.');}}
export function runnerError(error:unknown):Response{return Response.json({error:error instanceof RunnerError?error.message:'Runner operation failed.'},{status:error instanceof RunnerError?error.status:500,headers:{'Cache-Control':'no-store'}});}
