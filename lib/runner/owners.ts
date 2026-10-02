/**
 * Who may have a background runner. The owner (RUNNER_OWNER_ID on the runner, DUGOUT_OWNER_ID on the site) always may.
 * The allow-list (RUNNER_OWNERS on the runner, DUGOUT_RUNNER_USERS on the site) adds others: "*" for every signed-in user
 * (the site's sign-in, such as the Cloudflare Access invite list, is then the gate) or a comma list of account ids.
 * Each allowed account gets its own runner instance and its own paper account; nobody can reach another's.
 */
export const ACCOUNT_ID=/^[a-zA-Z0-9_-]{8,160}$/;

export function runnerAllowed(owner:string,primary:string|undefined,allowList:string|undefined):boolean {
  if(!ACCOUNT_ID.test(owner))return false;
  if(primary&&ACCOUNT_ID.test(primary)&&owner===primary)return true;
  const list=(allowList??'').split(',').map(entry=>entry.trim()).filter(Boolean);
  return list.includes('*')||list.includes(owner);
}
