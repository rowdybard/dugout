import {defaultEngine,type Engine} from './engine.ts';
import {LivePack,urlSource,type LivePackStatus} from './sources.ts';

/**
 * Engine for a Node host (scripts, CI jobs). With DUGOUT_EVIDENCE_PACK_URL set, the latest published
 * pack is streamed in (docs/DATA-PLATFORM.md); DUGOUT_EVIDENCE_PACK_SHA256 pins it so proven rows count.
 * Without the URL, or if the pack cannot be loaded or validated, the bundled engine is used.
 */
export async function engineFromEnv(env:Record<string,string|undefined>=process.env):Promise<{engine:Engine;status:LivePackStatus|null}> {
  const url=env.DUGOUT_EVIDENCE_PACK_URL?.trim();
  if(!url)return {engine:defaultEngine,status:null};
  const live=new LivePack(urlSource(url),{pinSha256:env.DUGOUT_EVIDENCE_PACK_SHA256?.trim()||null});
  const status=await live.refresh();
  return {engine:live.current(),status};
}
