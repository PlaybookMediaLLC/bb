# Marketing Assets

The Marketing Assets plugin gives BB agents and scripts a private Cloudflare R2 asset library. It owns the `marketing-assets/` object prefix and never exposes R2 credentials.

Configure `accountId`, `bucket`, `accessKeyId`, and `secretAccessKey` in
Extensions → Plugins → Marketing Assets, then reload the plugin. BB stores the
two credential fields as protected plugin secrets. Use an R2 API token limited
to Object Read and Write for this bucket. Keep the bucket private.

For local MinIO testing, leave `accountId` empty and set `endpoint` to a
loopback URL such as `http://127.0.0.1:9000`. The endpoint override rejects
non-loopback hosts and uses S3 path-style requests.

```sh
bb assets status
bb assets upload creative.png
bb assets list --json
bb assets url marketing-assets/<key>
bb assets download marketing-assets/<key> --out ./creative.png
bb assets delete marketing-assets/<key> --yes
```

Uploads and downloads are limited to 25 MiB. Download commands create new files
and refuse to overwrite existing files. Signed download URLs expire after 15
minutes and must be treated as bearer secrets.

SDK callers use the standard plugin RPC surface:

```ts
const result = await sdk.plugins.callRpc({
  pluginId: "marketing-assets-r2",
  method: "listAssets",
  input: { cursor: null, limit: 100 },
  outputSchema,
});
```

The RPC surface includes `uploadFromWorkspace`, `downloadToWorkspace`,
`listAssets`, `createDownloadUrl`, and `deleteAsset`. Workspace operations take
an explicit `rootPath` and nullable `hostId`.

Run the real MinIO integration test with:

```sh
BB_TEST_MINIO_ENDPOINT=http://127.0.0.1:9000 \
BB_TEST_MINIO_ACCESS_KEY=minioadmin \
BB_TEST_MINIO_SECRET_KEY=minioadmin \
BB_TEST_MINIO_BUCKET=marketing-assets \
pnpm exec turbo run test --filter=bb-plugin-marketing-assets-r2 \
  --env-mode=loose --force
```
