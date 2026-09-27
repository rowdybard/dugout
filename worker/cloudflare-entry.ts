import handler from 'vinext/server/fetch-handler';
import {withAccessIdentity,type AccessEnv} from '../lib/server/cloudflare-access.ts';

/**
 * Worker entry for self-hosting on Cloudflare (DUGOUT_HOSTING=cloudflare builds; docs/CLOUDFLARE-HOSTING.md).
 * Every request must carry a valid Cloudflare Access token; the app then sees the verified identity exactly as it did
 * behind ChatGPT Sites. The Sites build keeps using vinext's handler directly.
 */
const worker={
  async fetch(request:Request,env:Cloudflare.Env&AccessEnv,ctx:ExecutionContext):Promise<Response> {
    const next=await withAccessIdentity(request,env);
    return next instanceof Response?next:handler.fetch(next,env,ctx);
  },
};

export default worker;
