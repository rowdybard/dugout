import {env} from 'cloudflare:workers';
import {db} from '@/lib/server/storage';
import {handleRunnerMigration} from '@/lib/runner/sites-migration';
import {runnerError} from '@/lib/runner/protocol';
import type {RunnerBindings} from '@/lib/runner/sites-proxy';

export async function GET(request:Request){try{return await handleRunnerMigration(request,db(),env as RunnerBindings);}catch(error){return runnerError(error);}}
export async function POST(request:Request){try{return await handleRunnerMigration(request,db(),env as RunnerBindings);}catch(error){return runnerError(error);}}
