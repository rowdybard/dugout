import {BUNDLED_PACK,type EvidencePack,type Trust} from './pack.ts';

/**
 * Evidence packs a host has loaded, by version. A bot session pins one version in its config, so a replay
 * of its journal uses the same evidence. The bundled pack is always present. A version string can never be
 * re-registered with different contents, so a pinned version always means the same rules.
 */

type Entry={pack:EvidencePack;trust:Trust;fingerprint:string};
const fingerprintOf=(pack:EvidencePack)=>JSON.stringify([pack.evidence,pack.models??[]]);
const packs=new Map<string,Entry>([[BUNDLED_PACK.version,{pack:BUNDLED_PACK,trust:'bundled',fingerprint:fingerprintOf(BUNDLED_PACK)}]]);

export function registerPack(pack:EvidencePack,trust:Trust):{ok:true}|{ok:false;error:string} {
  const existing=packs.get(pack.version),fingerprint=fingerprintOf(pack);
  if(existing&&existing.fingerprint!==fingerprint)return {ok:false,error:`Pack version ${pack.version} is already registered with different contents.`};
  // Trust only ever increases for identical contents (an unpinned copy cannot downgrade a pinned one, or vice versa widen).
  if(!existing||(existing.trust==='untrusted'&&trust!=='untrusted'))packs.set(pack.version,{pack,trust,fingerprint});
  return {ok:true};
}

export function packFor(version:string|null|undefined):{pack:EvidencePack;trust:Trust}|null {
  const entry=packs.get(version??BUNDLED_PACK.version);
  return entry?{pack:entry.pack,trust:entry.trust}:null;
}

export const registeredPackVersions=()=>[...packs.keys()];
