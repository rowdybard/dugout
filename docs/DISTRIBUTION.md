# Source ZIP and restore notes

The complete **source** package includes frontend, Sites backend routes, Cloudflare runner, optional Node stream service, shared engine/execution code, tests, fixtures, assets, vendored CSS/license, public research datasets, database schema/migrations, package/lock files, configuration templates and documentation.

It excludes `node_modules`, `.git`, generated build/type-check artifacts, runtime/cache directories, actual environment/credential files, and ignored `outputs` research/account exports. `.env.example` has blank secret values. `.openai/hosting.json` identifies the existing Sites project and binding names but provides no authorization.

`SOURCE-MANIFEST.json` inside the archive identifies its source commit and SHA256 for every packaged source file. The manifest describes source bytes; it does not certify application behavior. A sibling `.sha256` file verifies ZIP bytes. Packaging verification reads each completed archive entry and compares its hash/length with the manifest.

## Not a live-database backup

Sites D1, the native Durable Object database, hosting access policy, runtime secrets, provider credentials and active processes are external state. They are not embedded in this archive. Installing source alone does not recreate the hosted account, balance, history or authentication.

Existing journal exports remain in the original checkout's ignored `outputs` folder. For a current account record, use **More details → History → Download complete saved history** in the authenticated dashboard. Store the JSON separately as private account data. It is audit/replay evidence, not a promised one-click restore format. Moving it to another deployment requires the migration protocol and verified owner/epoch mapping. Never overwrite a live account with an old cash snapshot.

## Restore source

1. Extract `dugout/` to a new directory.
2. Read the README, `chad.md` and manual.
3. Install the pinned prerequisites/dependencies and run the listed checks/builds.
4. Initialize an empty local D1 database with the included migrations for local development. Local identity is distinct from the deployed owner.
5. For another hosted deployment, configure authentication, owner identity, bindings and server secrets. Do not blindly deploy over the copied hosting project ID or reuse an unrelated account's journal namespace.
6. For this existing deployment, preserve private access, namespace, fence and history. Unpacking or deploying source must not resume the runner automatically.

The ZIP includes no paid plan, account entitlement, API credit, working key or guaranteed model/provider access.
