import {RunnerError} from '../../../lib/runner/protocol.ts';

export type FeedCredentials={keyId:string;secretKey:string};
export type EncryptedFeedCredentials={version:1;owner:string;epoch:string;iv:string;ciphertext:string};
const encoder=new TextEncoder();
const b64=(v:Uint8Array)=>btoa(String.fromCharCode(...v));
const unb64=(v:string)=>Uint8Array.from(atob(v),c=>c.charCodeAt(0));
const aad=(owner:string,epoch:string)=>encoder.encode(JSON.stringify(['dugout-provider-credentials-v1',owner,epoch]));
export function validateFeedCredentials(value:unknown):FeedCredentials{
  const v=value as FeedCredentials;
  if(!v||typeof v.keyId!=='string'||!/^[a-zA-Z0-9_-]{1,200}$/.test(v.keyId)||typeof v.secretKey!=='string'||v.secretKey.length>128)throw new RunnerError(400,'Invalid provider credential format.');
  try{if(![32,64].includes(unb64(v.secretKey).length))throw new Error();}catch{throw new RunnerError(400,'Invalid provider credential format.');}
  return {keyId:v.keyId,secretKey:v.secretKey};
}
async function encryptionKey(secret:string,owner:string,epoch:string){
  if(typeof secret!=='string'||secret.length<32)throw new RunnerError(503,'Runner signing configuration is unavailable.');
  const material=await crypto.subtle.importKey('raw',encoder.encode(secret),'HKDF',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'HKDF',hash:'SHA-256',salt:aad(owner,epoch),info:encoder.encode('provider-credentials')},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
export async function encryptFeedCredentials(value:unknown,secret:string,owner:string,epoch:string):Promise<EncryptedFeedCredentials>{
  const credentials=validateFeedCredentials(value),iv=crypto.getRandomValues(new Uint8Array(12));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv,additionalData:aad(owner,epoch)},await encryptionKey(secret,owner,epoch),encoder.encode(JSON.stringify(credentials)));
  return {version:1,owner,epoch,iv:b64(iv),ciphertext:b64(new Uint8Array(ciphertext))};
}
export async function decryptFeedCredentials(value:EncryptedFeedCredentials,secret:string,owner:string,epoch:string):Promise<FeedCredentials>{
  if(value.version!==1||value.owner!==owner||value.epoch!==epoch)throw new RunnerError(409,'Provider credential identity differs.');
  try{return validateFeedCredentials(JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv:unb64(value.iv),additionalData:aad(owner,epoch)},await encryptionKey(secret,owner,epoch),unb64(value.ciphertext)))));}
  catch{throw new RunnerError(503,'Provider credentials could not be read.');}
}
