'use client';

import {useState} from 'react';
import type {TennisRuntime} from '@/lib/tennis/types';

/**
 * Your own Polymarket US key, for live prices in your own background runner. The key is checked, sent once to your
 * runner (encrypted there), and never shown again; this page only learns whether one is set.
 */
export function FeedKey({runtime,onChange}:{runtime:TennisRuntime|null;onChange:()=>Promise<void>}) {
  const [keyId,setKeyId]=useState(''),[secretKey,setSecretKey]=useState('');
  const [busy,setBusy]=useState(false),[message,setMessage]=useState<string|null>(null);
  if(runtime?.mode!=='service')return <section className="tennis-rule-summary" aria-label="Live prices"><b>Live prices</b><p>Turn on background running first. Your Polymarket key is kept in your own runner.</p></section>;
  const send=async(body:object,done:string)=>{
    setBusy(true);setMessage(null);
    try{
      const response=await fetch('/api/tennis/runner/key',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data=await response.json().catch(()=>({})) as {error?:string};
      setMessage(response.ok?done:data.error??'That did not work. Try again.');
      if(response.ok)await onChange();
    }catch{setMessage('Could not reach the site. Try again.');}
    finally{setKeyId('');setSecretKey('');setBusy(false);}
  };
  return <section className="tennis-rule-summary tennis-feed-key" aria-label="Live prices">
    <b>Live prices</b>
    {runtime.feedKey?<>
      <p>On, using your own Polymarket key. It is stored encrypted in your runner and cannot be shown again.</p>
      <button className="tennis-secondary" disabled={busy} onClick={()=>void send({remove:true},'Key removed. Prices are checked every few seconds instead.')}>Remove my key</button>
    </>:<>
      <p>Optional. Add your own Polymarket US API key and your bot gets every price change instantly instead of checking every few seconds. It is only used to read prices. Make a separate key for this; you can revoke it on Polymarket any time.</p>
      <form onSubmit={event=>{event.preventDefault();void send({keyId:keyId.trim(),secretKey:secretKey.trim()},'Key checked and saved. Live prices start within a minute.');}}>
        <label>Key ID<input value={keyId} onChange={event=>setKeyId(event.target.value)} autoComplete="off" spellCheck={false} required maxLength={200}/></label>
        <label>Secret key<input type="password" value={secretKey} onChange={event=>setSecretKey(event.target.value)} autoComplete="new-password" spellCheck={false} required maxLength={128}/></label>
        <button className="tennis-secondary" disabled={busy||!keyId.trim()||!secretKey.trim()}>{busy?'Checking…':'Check and save'}</button>
      </form>
    </>}
    {message&&<p role="status" className="tennis-order-help">{message}</p>}
  </section>;
}
