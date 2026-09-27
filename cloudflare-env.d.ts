declare namespace Cloudflare {
  interface Env {
    DB?: D1Database;
    BUCKET?: R2Bucket;
    /** Self-hosted on Cloudflare only (docs/CLOUDFLARE-HOSTING.md). */
    ACCESS_TEAM_DOMAIN?: string;
    ACCESS_AUD?: string;
  }
}
interface ImportMeta { readonly env: {readonly DEV:boolean;readonly PROD:boolean} }
