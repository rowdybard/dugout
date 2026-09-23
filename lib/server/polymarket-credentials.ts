import {env} from 'cloudflare:workers';
import {PolymarketUS} from 'polymarket-us';
import {cached} from './storage';
import {polymarketSecrets,verifyCredentials} from '../trading/credentials';

export async function credentialStatus(){
  const values=env as unknown as Record<string,unknown>;
  const secrets=polymarketSecrets(values);
  const fingerprint=secrets?Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(JSON.stringify(secrets))))).map(v=>v.toString(16).padStart(2,'0')).join(''):'missing';
  // Cache only redacted status. No key, signature, account balance or account ID is stored.
  return cached(`polymarket:credential-status:${fingerprint}`,120000,()=>verifyCredentials(values,async credentials=>{
    const client=new PolymarketUS({...credentials,timeout:8000});
    return client.account.balances();
  }));
}
