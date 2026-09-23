/** Reject promptly while retaining a rejection handler on the cancelled source task. */
export function abortable<T>(task:Promise<T>,signal?:AbortSignal):Promise<T>{
  if(!signal)return task;
  return new Promise((resolve,reject)=>{
    const abort=()=>reject(signal.reason);
    if(signal.aborted)abort();else signal.addEventListener('abort',abort,{once:true});
    task.then(resolve,reject).finally(()=>signal.removeEventListener('abort',abort));
  });
}

export function sourceError(error:unknown,fallback='Data is temporarily unavailable.'):string{
  if(error instanceof Error&&['TimeoutError','AbortError'].includes(error.name))return 'A data source took too long. The next check will retry with fresh data.';
  return error instanceof Error?error.message:fallback;
}
