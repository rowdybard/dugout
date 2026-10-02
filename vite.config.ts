import vinext from "vinext";
import { defineConfig } from "vite";
import hostingConfig from "./.openai/hosting.json";
import { readExecutionProfile } from "./scripts/execution-profile.mjs";
import { sites } from "./build/sites-vite-plugin";

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  "00000000-0000-4000-8000-000000000000";

const { d1, r2 } = hostingConfig;

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const managedLinux = readExecutionProfile() === "managed-linux";

const localBindingConfig = {
  main: "vinext/server/fetch-handler",
  compatibility_flags: ["nodejs_compat"],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: "site-creator-d1",
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: "site-creator-r2",
        },
      ]
    : [],
};

/**
 * Self-hosting on Cloudflare behind Cloudflare Access (docs/CLOUDFLARE-HOSTING.md): `DUGOUT_HOSTING=cloudflare`
 * builds the site as the owner's own Worker. Every request is checked for a valid Access token in
 * worker/cloudflare-entry.ts. Without the variable, the build stays the ChatGPT Sites build.
 */
// Cloudflare's git-connected builds (Workers Builds, WORKERS_CI=1) always build the locked self-hosted site: the
// Sites build has no Access gate and must never be deployed there.
const workersBuilds = process.env.WORKERS_CI === "1";
const cloudflareHosting = process.env.DUGOUT_HOSTING === "cloudflare" || workersBuilds;
if (workersBuilds) {
  const missing = ["DUGOUT_D1_DATABASE_ID", "ACCESS_TEAM_DOMAIN", "ACCESS_AUD"].filter((name) => !process.env[name]?.trim());
  if (missing.length)
    throw new Error(
      `Cloudflare build stopped: set ${missing.join(", ")} under your Worker > Settings > Build > Variables and secrets, ` +
        "then retry the build. See docs/CLOUDFLARE-HOSTING.md (Deploy from GitHub).",
    );
}
const selfHostedConfig = {
  name: process.env.DUGOUT_WORKER_NAME || "dugout",
  main: "./worker/cloudflare-entry.ts",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: true,
  preview_urls: false,
  observability: { enabled: true, head_sampling_rate: 0.1 },
  d1_databases: [
    {
      binding: "DB",
      database_name: process.env.DUGOUT_D1_NAME || "dugout",
      database_id:
        process.env.DUGOUT_D1_DATABASE_ID || SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
      // Relative to dist/server/wrangler.json; the Sites plugin copies drizzle/ to dist/.openai/drizzle at build.
      migrations_dir: "../.openai/drizzle",
    },
  ],
  vars: {
    ACCESS_TEAM_DOMAIN: process.env.ACCESS_TEAM_DOMAIN || "",
    ACCESS_AUD: process.env.ACCESS_AUD || "",
  },
};

export default defineConfig(async () => {
  // Use Miniflare's local Request.cf placeholder unless fetching is requested.
  process.env.CLOUDFLARE_CF_FETCH_ENABLED ??= "false";
  process.env.WRANGLER_SEND_METRICS ??= "false";

  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= "false";
  process.env.WRANGLER_LOG_PATH ??= ".wrangler/logs";
  process.env.WRANGLER_REGISTRY_PATH ??= ".wrangler/dev-registry";
  process.env.MINIFLARE_REGISTRY_PATH ??= ".wrangler/registry";

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const { cloudflare } = await import("@cloudflare/vite-plugin");

  return {
    server: {
      ...(managedLinux ? { host: "0.0.0.0", allowedHosts: ["terminal.local"] } : {}),
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
    },
    plugins: [
      vinext(),
      sites({ mockAuth: !managedLinux && !cloudflareHosting }),
      cloudflare({
        viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
        inspectorPort: false,
        config: cloudflareHosting ? selfHostedConfig : localBindingConfig,
      }),
    ],
  };
});
