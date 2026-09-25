/** Official US Ed25519 handshake, matching polymarket-us 0.1.1. Server only. */
export async function marketSocketHeaders(keyId:string,secretKey:string,now=Date.now()){
  const raw=Uint8Array.from(atob(secretKey),c=>c.charCodeAt(0));
  if(raw.length!==32&&raw.length!==64)throw new Error('Invalid US signing key format.');
  const prefix=Uint8Array.from([0x30,0x2e,0x02,0x01,0x00,0x30,0x05,0x06,0x03,0x2b,0x65,0x70,0x04,0x22,0x04,0x20]);
  const encoded=new Uint8Array(prefix.length+32);encoded.set(prefix);encoded.set(raw.slice(0,32),prefix.length);
  const key=await crypto.subtle.importKey('pkcs8',encoded,{name:'Ed25519'},false,['sign']);
  const timestamp=String(now);
  const signature=new Uint8Array(await crypto.subtle.sign('Ed25519',key,new TextEncoder().encode(`${timestamp}GET/v1/ws/markets`)));
  return {'X-PM-Access-Key':keyId,'X-PM-Timestamp':timestamp,'X-PM-Signature':btoa(String.fromCharCode(...signature))};
}
