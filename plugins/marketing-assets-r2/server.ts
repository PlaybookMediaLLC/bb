import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import {
  defineRpcContract,
  type BbPluginApi,
  type PluginCliContext,
  type PluginCliResult,
} from "@get-bb/plugin-sdk";
import { z } from "zod";

const ASSET_PREFIX = "marketing-assets/";
const MAX_ASSET_BYTES = 25 * 1024 * 1024;
const DOWNLOAD_URL_TTL_SECONDS = 15 * 60;

const assetKeySchema = z
  .string()
  .min(ASSET_PREFIX.length + 1)
  .refine((key) => key.startsWith(ASSET_PREFIX), {
    message: `key must start with ${ASSET_PREFIX}`,
  });

const assetSchema = z
  .object({
    key: assetKeySchema,
    name: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    lastModifiedAt: z.number().int().nonnegative().nullable(),
    etag: z.string().nullable(),
  })
  .strict();

const configurationStatusSchema = z
  .object({
    configured: z.boolean(),
    bucket: z.string().nullable(),
    missing: z.array(z.string()),
    error: z.string().nullable(),
  })
  .strict();

export const marketingAssetsRpcContract = defineRpcContract({
  status: { input: z.null(), output: configurationStatusSchema },
  listAssets: {
    input: z
      .object({
        cursor: z.string().min(1).nullable(),
        limit: z.number().int().min(1).max(250),
      })
      .strict(),
    output: z
      .object({
        assets: z.array(assetSchema),
        nextCursor: z.string().nullable(),
      })
      .strict(),
  },
  uploadFromWorkspace: {
    input: z
      .object({
        hostId: z.string().min(1).nullable(),
        rootPath: z.string().min(1),
        path: z.string().min(1),
        contentType: z.string().min(1).max(255).nullable(),
      })
      .strict(),
    output: z.object({ key: assetKeySchema }).strict(),
  },
  downloadToWorkspace: {
    input: z
      .object({
        hostId: z.string().min(1).nullable(),
        rootPath: z.string().min(1),
        path: z.string().min(1),
        key: assetKeySchema,
      })
      .strict(),
    output: z
      .object({
        key: assetKeySchema,
        path: z.string(),
        sizeBytes: z.number().int().nonnegative(),
      })
      .strict(),
  },
  createDownloadUrl: {
    input: z.object({ key: assetKeySchema }).strict(),
    output: z
      .object({ url: z.url(), expiresAt: z.number().int().positive() })
      .strict(),
  },
  deleteAsset: {
    input: z.object({ key: assetKeySchema }).strict(),
    output: z
      .object({ deleted: z.literal(true), key: assetKeySchema })
      .strict(),
  },
});

export type MarketingAsset = z.infer<typeof assetSchema>;
export type MarketingAssetsConfigurationStatus = z.infer<
  typeof configurationStatusSchema
>;

export interface MarketingAssetsStore {
  list(args: {
    cursor: string | null;
    limit: number;
  }): Promise<{ assets: MarketingAsset[]; nextCursor: string | null }>;
  upload(args: {
    fileName: string;
    contentType: string;
    body: Uint8Array;
  }): Promise<{ key: string }>;
  download(key: string): Promise<Uint8Array>;
  createDownloadUrl(key: string): Promise<{ url: string; expiresAt: number }>;
  delete(key: string): Promise<void>;
}

interface R2Configuration {
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  endpoint: string;
  forcePathStyle: boolean;
  region: "auto" | "us-east-1";
}

const configurationSchema = z
  .object({
    accountId: z
      .string()
      .regex(/^[a-f0-9]{32}$/i, "must be a 32-character account ID")
      .optional(),
    endpoint: z
      .url()
      .refine((value) => {
        const url = new URL(value);
        return (
          (url.protocol === "http:" || url.protocol === "https:") &&
          ["127.0.0.1", "[::1]", "localhost"].includes(url.hostname) &&
          url.username === "" &&
          url.password === "" &&
          url.pathname === "/" &&
          url.search === "" &&
          url.hash === ""
        );
      }, "must be an HTTP(S) loopback origin without credentials, path, query, or fragment")
      .optional(),
    bucket: z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/,
        "must be a valid R2 bucket name",
      ),
    accessKeyId: z.string().min(1),
    secretAccessKey: z.string().min(1),
  })
  .refine((value) => !(value.accountId && value.endpoint), {
    message: "accountId and endpoint are mutually exclusive",
  })
  .strict();

const REQUIRED_SETTING_KEYS = [
  "bucket",
  "accessKeyId",
  "secretAccessKey",
] as const;

interface R2Settings {
  accountId?: string;
  endpoint?: string;
  bucket?: string;
  accessKeyId?: string;
  secretAccessKey?: string;
}

export function resolveConfiguration(settings: R2Settings): {
  status: MarketingAssetsConfigurationStatus;
  configuration: R2Configuration | null;
} {
  const accountId = settings.accountId?.trim() || undefined;
  const endpoint = settings.endpoint?.trim().replace(/\/$/, "") || undefined;
  const missing: string[] = REQUIRED_SETTING_KEYS.filter(
    (key) => !settings[key]?.trim(),
  );
  if (!accountId && !endpoint) missing.unshift("accountId or endpoint");
  if (missing.length > 0) {
    return {
      status: {
        configured: false,
        bucket: settings.bucket?.trim() || null,
        missing: [...missing],
        error: null,
      },
      configuration: null,
    };
  }

  const parsed = configurationSchema.safeParse({
    accountId,
    endpoint,
    bucket: settings.bucket?.trim(),
    accessKeyId: settings.accessKeyId?.trim(),
    secretAccessKey: settings.secretAccessKey?.trim(),
  });
  if (!parsed.success) {
    return {
      status: {
        configured: false,
        bucket: settings.bucket?.trim() || null,
        missing: [],
        error: z.prettifyError(parsed.error),
      },
      configuration: null,
    };
  }
  const resolvedEndpoint = parsed.data.endpoint;
  if (!resolvedEndpoint && !parsed.data.accountId) {
    return {
      status: {
        configured: false,
        bucket: parsed.data.bucket,
        missing: ["accountId or endpoint"],
        error: null,
      },
      configuration: null,
    };
  }
  return {
    status: {
      configured: true,
      bucket: parsed.data.bucket,
      missing: [],
      error: null,
    },
    configuration: {
      bucket: parsed.data.bucket,
      accessKeyId: parsed.data.accessKeyId,
      secretAccessKey: parsed.data.secretAccessKey,
      endpoint:
        resolvedEndpoint ??
        `https://${parsed.data.accountId}.r2.cloudflarestorage.com`,
      forcePathStyle: resolvedEndpoint !== undefined,
      region: resolvedEndpoint ? "us-east-1" : "auto",
    },
  };
}

function safeFileName(rawName: string): string {
  const baseName = rawName.replaceAll("\\", "/").split("/").at(-1) ?? "";
  const cleaned = baseName
    .normalize("NFKC")
    .replace(/[^a-zA-Z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 120);
  return cleaned || "asset";
}

function assetKey(fileName: string): string {
  return `${ASSET_PREFIX}${randomUUID()}-${safeFileName(fileName)}`;
}

class R2MarketingAssetsStore implements MarketingAssetsStore {
  readonly #client: S3Client;
  readonly #bucket: string;

  constructor(configuration: R2Configuration) {
    this.#bucket = configuration.bucket;
    this.#client = new S3Client({
      region: configuration.region,
      endpoint: configuration.endpoint,
      forcePathStyle: configuration.forcePathStyle,
      credentials: {
        accessKeyId: configuration.accessKeyId,
        secretAccessKey: configuration.secretAccessKey,
      },
    });
  }

  async list(args: { cursor: string | null; limit: number }) {
    const result = await this.#client.send(
      new ListObjectsV2Command({
        Bucket: this.#bucket,
        Prefix: ASSET_PREFIX,
        MaxKeys: args.limit,
        ContinuationToken: args.cursor ?? undefined,
      }),
    );
    return {
      assets: (result.Contents ?? []).flatMap((object) => {
        const key = object.Key;
        if (!key || !key.startsWith(ASSET_PREFIX)) return [];
        return [
          {
            key,
            name: key.slice(ASSET_PREFIX.length),
            sizeBytes: object.Size ?? 0,
            lastModifiedAt: object.LastModified?.getTime() ?? null,
            etag: object.ETag?.replace(/^"|"$/g, "") ?? null,
          },
        ];
      }),
      nextCursor: result.NextContinuationToken ?? null,
    };
  }

  async upload(args: {
    fileName: string;
    contentType: string;
    body: Uint8Array;
  }) {
    const key = assetKey(args.fileName);
    await this.#client.send(
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: args.body,
        ContentLength: args.body.byteLength,
        ContentType: args.contentType,
      }),
    );
    return { key };
  }

  async download(key: string) {
    const result = await this.#client.send(
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
    if ((result.ContentLength ?? 0) > MAX_ASSET_BYTES) {
      throw new Error(
        `asset exceeds the ${MAX_ASSET_BYTES}-byte download limit`,
      );
    }
    if (!result.Body) throw new Error("R2 returned an empty response body");
    const body = await result.Body.transformToByteArray();
    if (body.byteLength > MAX_ASSET_BYTES) {
      throw new Error(
        `asset exceeds the ${MAX_ASSET_BYTES}-byte download limit`,
      );
    }
    return body;
  }

  async createDownloadUrl(key: string) {
    const expiresAt = Date.now() + DOWNLOAD_URL_TTL_SECONDS * 1000;
    const url = await getSignedUrl(
      this.#client,
      new GetObjectCommand({ Bucket: this.#bucket, Key: key }),
      { expiresIn: DOWNLOAD_URL_TTL_SECONDS },
    );
    return { url, expiresAt };
  }

  async delete(key: string) {
    await this.#client.send(
      new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }),
    );
  }
}

function requireStore(
  store: MarketingAssetsStore | null,
): MarketingAssetsStore {
  if (!store) {
    throw new Error(
      "R2 is not configured; configure accountId or endpoint, bucket, accessKeyId, and secretAccessKey, then reload the plugin",
    );
  }
  return store;
}

function parseCli(
  argv: string[],
  valueFlags: ReadonlySet<string>,
  booleanFlags: ReadonlySet<string>,
): {
  positional: string[];
  values: Map<string, string>;
  booleans: Set<string>;
} {
  const positional: string[] = [];
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positional.push(value);
      continue;
    }
    if (booleanFlags.has(value)) {
      if (booleans.has(value)) throw new Error(`duplicate flag: ${value}`);
      booleans.add(value);
      continue;
    }
    if (!valueFlags.has(value)) throw new Error(`unknown flag: ${value}`);
    const flagValue = argv[index + 1];
    if (!flagValue || flagValue.startsWith("--")) {
      throw new Error(`${value} requires a value`);
    }
    if (values.has(value)) throw new Error(`duplicate flag: ${value}`);
    values.set(value, flagValue);
    index += 1;
  }
  return { positional, values, booleans };
}

function contentTypeFor(filePath: string): string {
  switch (path.extname(filePath).toLowerCase()) {
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".svg":
      return "image/svg+xml";
    case ".pdf":
      return "application/pdf";
    case ".mp4":
      return "video/mp4";
    case ".mov":
      return "video/quicktime";
    default:
      return "application/octet-stream";
  }
}

function pathApi(rootPath: string): typeof path.posix | typeof path.win32 {
  return path.win32.isAbsolute(rootPath) && !path.posix.isAbsolute(rootPath)
    ? path.win32
    : path.posix;
}

async function workspaceHostId(
  bb: BbPluginApi,
  context: PluginCliContext,
): Promise<string | undefined> {
  if (!context.threadId) return undefined;
  const thread = await bb.sdk.threads.get({ threadId: context.threadId });
  if (!thread.environmentId) return undefined;
  const environment = await bb.sdk.environments.get({
    environmentId: thread.environmentId,
  });
  return environment.hostId;
}

function usage(message: string): PluginCliResult {
  return { exitCode: 2, stderr: message };
}

async function uploadFromWorkspace(
  bb: BbPluginApi,
  store: MarketingAssetsStore,
  args: {
    hostId: string | null;
    rootPath: string;
    path: string;
    contentType: string | null;
    signal?: AbortSignal;
  },
): Promise<{ key: string }> {
  const filePath = pathApi(args.rootPath).resolve(args.rootPath, args.path);
  const file = await bb.sdk.files.read({
    ...(args.hostId ? { hostId: args.hostId } : {}),
    path: filePath,
    rootPath: args.rootPath,
    signal: args.signal,
  });
  const body = Buffer.from(
    file.content,
    file.contentEncoding === "base64" ? "base64" : "utf8",
  );
  if (body.byteLength === 0 || body.byteLength > MAX_ASSET_BYTES) {
    throw new Error(`asset must be from 1 to ${MAX_ASSET_BYTES} bytes`);
  }
  return store.upload({
    fileName: pathApi(args.rootPath).basename(filePath),
    contentType: args.contentType ?? contentTypeFor(filePath),
    body,
  });
}

async function downloadToWorkspace(
  bb: BbPluginApi,
  store: MarketingAssetsStore,
  args: {
    hostId: string | null;
    rootPath: string;
    path: string;
    key: string;
  },
): Promise<{ key: string; path: string; sizeBytes: number }> {
  const body = await store.download(args.key);
  const destination = pathApi(args.rootPath).resolve(args.rootPath, args.path);
  const result = await bb.sdk.files.write({
    ...(args.hostId ? { hostId: args.hostId } : {}),
    path: destination,
    rootPath: args.rootPath,
    content: Buffer.from(body).toString("base64"),
    contentEncoding: "base64",
    createParents: true,
    expectedSha256: null,
  });
  if (result.outcome === "conflict") {
    throw new Error(`refusing to overwrite existing file: ${destination}`);
  }
  return { key: args.key, path: destination, sizeBytes: body.byteLength };
}

export function registerMarketingAssetsPlugin(
  bb: BbPluginApi,
  status: MarketingAssetsConfigurationStatus,
  store: MarketingAssetsStore | null,
): void {
  bb.rpc.register(marketingAssetsRpcContract, {
    status() {
      return status;
    },
    listAssets(args) {
      return requireStore(store).list(args);
    },
    uploadFromWorkspace(args) {
      return uploadFromWorkspace(bb, requireStore(store), args);
    },
    downloadToWorkspace(args) {
      return downloadToWorkspace(bb, requireStore(store), args);
    },
    createDownloadUrl({ key }) {
      return requireStore(store).createDownloadUrl(key);
    },
    async deleteAsset({ key }) {
      await requireStore(store).delete(key);
      return { deleted: true as const, key };
    },
  });

  bb.cli.register({
    name: "assets",
    summary: "Manage private marketing assets in Cloudflare R2",
    commands: [
      {
        name: "status",
        summary: "Show R2 configuration status",
        usage: "bb assets status [--json]",
      },
      {
        name: "list",
        summary: "List assets",
        usage: "bb assets list [--limit <1-250>] [--cursor <cursor>] [--json]",
      },
      {
        name: "upload",
        summary: "Upload a workspace file",
        usage: "bb assets upload <path> [--content-type <type>] [--json]",
      },
      {
        name: "download",
        summary: "Download an asset",
        usage: "bb assets download <key> --out <path> [--json]",
      },
      {
        name: "url",
        summary: "Create a temporary download URL",
        usage: "bb assets url <key> [--json]",
      },
      {
        name: "delete",
        summary: "Delete an asset",
        usage: "bb assets delete <key> --yes [--json]",
      },
    ],
    async run(argv, context) {
      try {
        const command = argv[0];
        const rest = argv.slice(1);
        if (command === "status") {
          const parsed = parseCli(rest, new Set(), new Set(["--json"]));
          if (parsed.positional.length > 0)
            return usage("Usage: bb assets status [--json]");
          return {
            exitCode: 0,
            stdout: parsed.booleans.has("--json")
              ? JSON.stringify(status)
              : status.configured
                ? `R2 configured: ${status.bucket}`
                : `R2 not configured: ${status.error ?? status.missing.join(", ")}`,
          };
        }
        if (command === "list") {
          const parsed = parseCli(
            rest,
            new Set(["--limit", "--cursor"]),
            new Set(["--json"]),
          );
          if (parsed.positional.length > 0) {
            return usage(
              "Usage: bb assets list [--limit <1-250>] [--cursor <cursor>] [--json]",
            );
          }
          const limitText = parsed.values.get("--limit") ?? "100";
          const limit = Number(limitText);
          if (!Number.isInteger(limit) || limit < 1 || limit > 250) {
            return usage("--limit must be an integer from 1 to 250");
          }
          const result = await requireStore(store).list({
            cursor: parsed.values.get("--cursor") ?? null,
            limit,
          });
          return {
            exitCode: 0,
            stdout: parsed.booleans.has("--json")
              ? JSON.stringify(result)
              : result.assets
                  .map((asset) => `${asset.key}\t${asset.sizeBytes}`)
                  .join("\n"),
          };
        }
        if (command === "upload") {
          const parsed = parseCli(
            rest,
            new Set(["--content-type"]),
            new Set(["--json"]),
          );
          if (parsed.positional.length !== 1) {
            return usage(
              "Usage: bb assets upload <path> [--content-type <type>] [--json]",
            );
          }
          const rootPath = context.cwd ?? process.cwd();
          const hostId = await workspaceHostId(bb, context);
          const result = await uploadFromWorkspace(bb, requireStore(store), {
            hostId: hostId ?? null,
            rootPath,
            path: parsed.positional[0],
            contentType: parsed.values.get("--content-type") ?? null,
            signal: context.signal,
          });
          return {
            exitCode: 0,
            stdout: parsed.booleans.has("--json")
              ? JSON.stringify(result)
              : result.key,
          };
        }
        if (command === "download") {
          const parsed = parseCli(
            rest,
            new Set(["--out"]),
            new Set(["--json"]),
          );
          const outputPath = parsed.values.get("--out");
          if (parsed.positional.length !== 1 || !outputPath) {
            return usage(
              "Usage: bb assets download <key> --out <path> [--json]",
            );
          }
          const key = assetKeySchema.parse(parsed.positional[0]);
          const rootPath = context.cwd ?? process.cwd();
          const hostId = await workspaceHostId(bb, context);
          const output = await downloadToWorkspace(bb, requireStore(store), {
            hostId: hostId ?? null,
            key,
            path: outputPath,
            rootPath,
          });
          return {
            exitCode: 0,
            stdout: parsed.booleans.has("--json")
              ? JSON.stringify(output)
              : output.path,
          };
        }
        if (command === "url") {
          const parsed = parseCli(rest, new Set(), new Set(["--json"]));
          if (parsed.positional.length !== 1) {
            return usage("Usage: bb assets url <key> [--json]");
          }
          const key = assetKeySchema.parse(parsed.positional[0]);
          const result = await requireStore(store).createDownloadUrl(key);
          return {
            exitCode: 0,
            stdout: parsed.booleans.has("--json")
              ? JSON.stringify(result)
              : result.url,
          };
        }
        if (command === "delete") {
          const parsed = parseCli(
            rest,
            new Set(),
            new Set(["--yes", "--json"]),
          );
          if (parsed.positional.length !== 1) {
            return usage("Usage: bb assets delete <key> --yes [--json]");
          }
          if (!parsed.booleans.has("--yes")) {
            return usage("Refusing to delete without --yes");
          }
          const key = assetKeySchema.parse(parsed.positional[0]);
          await requireStore(store).delete(key);
          const output = { deleted: true, key };
          return {
            exitCode: 0,
            stdout: parsed.booleans.has("--json")
              ? JSON.stringify(output)
              : `Deleted ${key}`,
          };
        }
        return usage("Usage: bb assets status|list|upload|download|url|delete");
      } catch (error) {
        return {
          exitCode: 1,
          stderr: error instanceof Error ? error.message : String(error),
        };
      }
    },
  });
}

export default async function plugin(bb: BbPluginApi): Promise<void> {
  const settings = bb.settings.define({
    accountId: {
      type: "string",
      label: "Cloudflare account ID",
      description: "The account that owns the R2 bucket.",
    },
    endpoint: {
      type: "string",
      label: "Local S3 endpoint",
      description:
        "Development and testing only. Use a loopback MinIO URL and leave the Cloudflare account ID empty.",
    },
    bucket: {
      type: "string",
      label: "R2 bucket",
      description: "A private bucket for marketing assets.",
    },
    accessKeyId: {
      type: "string",
      label: "R2 access key ID",
      description:
        "Use a token limited to Object Read and Write for this bucket.",
      secret: true,
    },
    secretAccessKey: {
      type: "string",
      label: "R2 secret access key",
      description: "The secret for the same bucket-scoped token.",
      secret: true,
    },
  });
  const { status, configuration } = resolveConfiguration(await settings.get());
  if (!status.configured) {
    bb.status.needsConfiguration(
      status.error ??
        `Configure ${status.missing.join(", ")} and reload the plugin`,
    );
  }
  registerMarketingAssetsPlugin(
    bb,
    status,
    configuration ? new R2MarketingAssetsStore(configuration) : null,
  );
  bb.log.info("Marketing Assets loaded");
}
