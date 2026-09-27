import {z} from 'zod';

/**
 * The data lake's table of contents (docs/DATA-PLATFORM.md). research/datastore/lake.py writes
 * catalog.json next to the data; anything that needs research data (engine hosts, dashboards,
 * scripts, Chad's AI) reads the catalog instead of hard-coding paths.
 */

export const CATALOG_SCHEMA='dugout-catalog-v1';

const column=z.object({name:z.string().min(1),type:z.string().min(1),description:z.string().optional()}).strict();
export const datasetSchema=z.object({
  name:z.string().min(1).max(80).regex(/^[a-z0-9_]+$/),description:z.string().max(1000),
  format:z.enum(['parquet','ndjson','json','json.gz']),
  /** Folder under the catalog base; partitioned datasets use hive folders (league=cfb/month=2026-09). */
  path:z.string().min(1).max(300),
  partitions:z.array(z.string().min(1)).max(4).default([]),
  /** Every file, relative to the base, so HTTPS readers (which cannot list folders) can find them. */
  files:z.array(z.string().min(1)).max(100_000).default([]),
  columns:z.array(column).max(500).default([]),
  rows:z.number().int().nonnegative().nullable().default(null),
  bytes:z.number().int().nonnegative().nullable().default(null),
  updatedAt:z.string().min(1),
}).strict();
export const catalogSchema=z.object({
  schema:z.literal(CATALOG_SCHEMA),
  /** Public HTTPS base for reads (R2 public bucket or custom domain). Writes use the S3 API with keys. */
  base:z.string().url(),
  updatedAt:z.string().min(1),
  datasets:z.array(datasetSchema).max(500),
  /** Path of the current evidence pack and its SHA-256, for LivePack pinning. */
  evidencePack:z.object({path:z.string().min(1),sha256:z.string().regex(/^[0-9a-f]{64}$/).nullable()}).strict().nullable().default(null),
}).strict();

export type Dataset=z.infer<typeof datasetSchema>;
export type Catalog=z.infer<typeof catalogSchema>;

export function parseCatalog(raw:unknown):{ok:true;catalog:Catalog}|{ok:false;error:string} {
  const parsed=catalogSchema.safeParse(raw);
  if(!parsed.success){const issue=parsed.error.issues[0];return {ok:false,error:`${issue.path.join('.')||'catalog'}: ${issue.message}`};}
  return {ok:true,catalog:parsed.data};
}

const join=(base:string,path:string)=>`${base.replace(/\/+$/,'')}/${path.replace(/^\/+/,'')}`;

/** HTTPS URLs of a dataset's files, optionally filtered by partition values, e.g. {league:'cfb'}. */
export function datasetUrls(catalog:Catalog,name:string,filter:Record<string,string>={}):string[] {
  const dataset=catalog.datasets.find(d=>d.name===name);
  if(!dataset)throw new Error(`Unknown dataset ${name}. Known: ${catalog.datasets.map(d=>d.name).join(', ')}`);
  const wanted=Object.entries(filter).map(([key,value])=>`${key}=${value}`);
  return dataset.files.filter(file=>wanted.every(part=>file.split('/').includes(part))).map(file=>join(catalog.base,file));
}

export function evidencePackUrl(catalog:Catalog):{url:string;sha256:string|null}|null {
  return catalog.evidencePack?{url:join(catalog.base,catalog.evidencePack.path),sha256:catalog.evidencePack.sha256}:null;
}

/** A DuckDB query any reader can paste into the DuckDB CLI or shell.duckdb.org (runs in the browser). */
export function duckdbSelect(catalog:Catalog,name:string,filter:Record<string,string>={},limit=100):string {
  const urls=datasetUrls(catalog,name,filter);
  if(!urls.length)throw new Error(`No files for ${name} with ${JSON.stringify(filter)}.`);
  const dataset=catalog.datasets.find(d=>d.name===name)!;
  const reader=dataset.format==='parquet'?'read_parquet':'read_json_auto';
  return `SELECT * FROM ${reader}([${urls.map(u=>`'${u.replace(/'/g,"''")}'`).join(', ')}]${dataset.format==='parquet'&&dataset.partitions.length?', hive_partitioning = true':''}) LIMIT ${limit};`;
}
