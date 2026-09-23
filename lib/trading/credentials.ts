export type CredentialStatus={state:'not_configured'|'invalid_format'|'verified'|'rejected'|'unavailable';configured:boolean;checkedAt:number;message:string;liveEnabled:false};
type Secrets={keyId:string;secretKey:string};

/** Server callers only. Accept the existing setting alias without exposing either value. */
export function polymarketSecrets(values:Record<string,unknown>):Secrets|null{
  const value=(key:string)=>typeof values[key]==='string'?(values[key] as string).trim():'';
  const keyId=value('POLYMARKET_KEY_ID')||value('POLYNARKET_KEY_ID');
  const secretKey=value('POLYMARKET_SECRET_KEY');
  return keyId&&secretKey?{keyId,secretKey}:null;
}

/** Only a read-only account call is accepted here; no order client or balances are returned. */
export async function verifyCredentials(values:Record<string,unknown>,readAccount:(secrets:Secrets)=>Promise<unknown>,now=Date.now()):Promise<CredentialStatus>{
  const secrets=polymarketSecrets(values),base={configured:!!secrets,checkedAt:now,liveEnabled:false as const};
  if(!secrets)return {...base,state:'not_configured',message:'Polymarket US credentials are not configured. Public paper testing is available.'};
  try{const length=atob(secrets.secretKey).length;if(length!==32&&length!==64)throw new Error('Invalid length');}
  catch{return {...base,state:'invalid_format',message:'The signing secret must be the base64 Ed25519 secret from Polymarket US.'};}
  try{
    const response=await readAccount(secrets);
    if(!response||typeof response!=='object'||!Array.isArray((response as {balances?:unknown}).balances))return {...base,state:'unavailable',message:'Polymarket US returned an unexpected response. The connection is not verified.'};
    return {...base,state:'verified',message:'Polymarket US credentials verified. Paper mode remains active; streaming is not connected yet.'};
  }catch(error){
    const status=error&&typeof error==='object'?'status' in error?Number(error.status):null:null;
    if(status===401)return {...base,state:'rejected',message:'Polymarket US rejected these credentials. Check that the key ID and signing secret belong to the same US API key.'};
    if(status===403)return {...base,state:'rejected',message:'Polymarket US did not permit this account request. Check the key’s API access and account eligibility.'};
    return {...base,state:'unavailable',message:status===429?'Polymarket US asked us to slow down. Retry the connection check later.':'Polymarket US could not be reached for verification. Paper mode remains active.'};
  }
}
