import {DatabaseSync} from 'node:sqlite';

// Isolated in-memory test database. This file is never imported by the app.
const sqlite=new DatabaseSync(':memory:');
sqlite.exec('CREATE TABLE profiles(id TEXT PRIMARY KEY,value TEXT NOT NULL,version INTEGER NOT NULL DEFAULT 0); CREATE TABLE cache(key TEXT PRIMARY KEY,value TEXT NOT NULL,updated INTEGER NOT NULL); CREATE TABLE snapshots(id TEXT PRIMARY KEY,slug TEXT,time INTEGER,price REAL,bid REAL,ask REAL,volume REAL,depth REAL,signals TEXT); CREATE TABLE trading_observations(id TEXT PRIMARY KEY,slug TEXT,time INTEGER,price REAL,bid REAL,ask REAL,depth REAL,source TEXT);');
export const state={catalogCalls:0,inputCalls:0,replay:false};
export function reset(){sqlite.exec('DELETE FROM profiles; DELETE FROM cache;');state.catalogCalls=0;state.inputCalls=0;state.replay=false;}
class Statement{
  values:unknown[]=[];
  sql:string;
  constructor(sql:string){this.sql=sql;}
  bind(...values:unknown[]){this.values=values;return this;}
  async first(){return sqlite.prepare(this.sql).get(...this.values as never[])??null;}
  async all(){return {results:sqlite.prepare(this.sql).all(...this.values as never[])};}
  async run(){if(/^SELECT\s/i.test(this.sql.trim()))return {...await this.all(),meta:{changes:0}};const result=sqlite.prepare(this.sql).run(...this.values as never[]);return {meta:{changes:Number(result.changes)},results:[]};}
}
export const env={DB:{prepare:(sql:string)=>new Statement(sql),batch:async(statements:Statement[])=>{
  sqlite.exec('BEGIN');try{const results=[];for(const statement of statements)results.push(await statement.run());sqlite.exec('COMMIT');return results;}
  catch(error){sqlite.exec('ROLLBACK');throw error;}
}}};
export async function getCatalog(){state.catalogCalls++;throw new Error('Synthetic discovery outage');}
export async function loadBotInput(){state.inputCalls++;throw new Error('Synthetic source outage');}
export async function replayData(){return state.replay?{recordedAt:Date.now()}:null;}
