---
name: marketing-assets
description: Store and retrieve private marketing assets in Cloudflare R2. Use when an agent needs to upload, list, share temporarily, download, or delete campaign files.
---

# Marketing Assets

Use `bb assets` for the user's private marketing asset library.

1. Run `bb assets status` before the first operation. If configuration is
   missing, ask the user to complete Marketing Assets plugin settings and
   reload the plugin; never ask them to send credentials in chat.
2. Upload with `bb assets upload <workspace-path> --json`.
3. List with `bb assets list --json`. Pass `--cursor` when `nextCursor` is not null.
4. Create a short-lived download link with `bb assets url <key> --json`.
5. Download with `bb assets download <key> --out <workspace-path> --json`.
6. Delete only after the user approves it, then pass `--yes`.

Keys must start with `marketing-assets/`. Treat signed URLs as bearer secrets: do not persist them in files, logs, tasks, or documents. Do not make the R2 bucket public.
