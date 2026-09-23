declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
interface ImportMeta { readonly env: {readonly DEV:boolean;readonly PROD:boolean} }
