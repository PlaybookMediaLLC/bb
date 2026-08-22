import { describe, expect, it, vi } from "vitest";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import plugin, {
  registerMarketingAssetsPlugin,
  resolveConfiguration,
  type MarketingAssetsStore,
} from "./server";

const status = {
  configured: true,
  bucket: "marketing-assets",
  missing: [],
  error: null,
};

function fakeStore(): MarketingAssetsStore {
  return {
    list: vi.fn(async () => ({ assets: [], nextCursor: null })),
    upload: vi.fn(async () => ({ key: "marketing-assets/id-image.png" })),
    download: vi.fn(async () => new Uint8Array([1, 2, 3])),
    createDownloadUrl: vi.fn(async () => ({
      url: "https://example.com/download",
      expiresAt: 1,
    })),
    delete: vi.fn(async () => undefined),
  };
}

describe("Marketing Assets plugin", () => {
  it("stores credentials as plugin secrets and loads without them", async () => {
    const { bb, harness } = createFakePluginHost({
      pluginId: "marketing-assets-r2",
    });

    await plugin(bb);

    expect(harness.registrations.settingsDescriptors).toMatchObject({
      accessKeyId: { secret: true },
      secretAccessKey: { secret: true },
    });
    expect(harness.needsConfigurationMessages).toHaveLength(1);
    await expect(harness.callRpc("status", null)).resolves.toMatchObject({
      configured: false,
    });
  });

  it("reports missing configuration without exposing credentials", () => {
    expect(resolveConfiguration({ bucket: "marketing-assets" })).toEqual({
      status: {
        configured: false,
        bucket: "marketing-assets",
        missing: ["accountId or endpoint", "accessKeyId", "secretAccessKey"],
        error: null,
      },
      configuration: null,
    });
  });

  it("accepts a loopback MinIO endpoint without a Cloudflare account ID", () => {
    expect(
      resolveConfiguration({
        endpoint: "http://127.0.0.1:9000/",
        bucket: "marketing-assets",
        accessKeyId: "minioadmin",
        secretAccessKey: "minioadmin",
      }),
    ).toMatchObject({
      status: { configured: true, error: null },
      configuration: {
        endpoint: "http://127.0.0.1:9000",
        forcePathStyle: true,
        region: "us-east-1",
      },
    });
  });

  it.each([
    ["a remote endpoint", { endpoint: "https://s3.example.com" }],
    ["an endpoint path", { endpoint: "http://127.0.0.1:9000/private" }],
    [
      "an endpoint plus account ID",
      {
        endpoint: "http://127.0.0.1:9000",
        accountId: "0123456789abcdef0123456789abcdef",
      },
    ],
  ])("rejects %s", (_label, override) => {
    expect(
      resolveConfiguration({
        bucket: "marketing-assets",
        accessKeyId: "access-key",
        secretAccessKey: "secret-key",
        ...override,
      }),
    ).toMatchObject({
      status: { configured: false, missing: [] },
      configuration: null,
    });
  });

  it("uploads and downloads files through the invoking workspace host", async () => {
    const store = fakeStore();
    const { bb, harness } = createFakePluginHost({
      pluginId: "marketing-assets-r2",
      sdk: {
        threads: {
          get: async () => ({ environmentId: "environment-1" }),
        },
        environments: {
          get: async () => ({ hostId: "host-1" }),
        },
        files: {
          read: async () => ({
            content: "aGVsbG8=",
            contentEncoding: "base64" as const,
            sha256: "unused",
          }),
          write: async () => ({ outcome: "written" as const, sha256: "new" }),
        },
      },
    });
    registerMarketingAssetsPlugin(bb, status, store);

    await expect(
      harness.runCli(["upload", "campaign.png", "--json"], {
        cwd: "/workspace",
        threadId: "thread-1",
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: JSON.stringify({ key: "marketing-assets/id-image.png" }),
    });
    expect(store.upload).toHaveBeenCalledWith({
      fileName: "campaign.png",
      contentType: "image/png",
      body: Buffer.from("hello"),
    });

    await expect(
      harness.runCli(
        ["download", "marketing-assets/id-image.png", "--out", "out/image.png"],
        { cwd: "/workspace", threadId: "thread-1" },
      ),
    ).resolves.toMatchObject({
      exitCode: 0,
      stdout: "/workspace/out/image.png",
    });
    expect(harness.sdk.callsTo("files.write")[0]?.[0]).toMatchObject({
      hostId: "host-1",
      path: "/workspace/out/image.png",
      rootPath: "/workspace",
      content: "AQID",
      contentEncoding: "base64",
      expectedSha256: null,
    });
  });

  it("requires explicit delete confirmation and confines keys to its prefix", async () => {
    const store = fakeStore();
    const { bb, harness } = createFakePluginHost({
      pluginId: "marketing-assets-r2",
    });
    registerMarketingAssetsPlugin(bb, status, store);

    await expect(
      harness.runCli(["delete", "marketing-assets/id-image.png"]),
    ).resolves.toMatchObject({
      exitCode: 2,
      stderr: "Refusing to delete without --yes",
    });
    expect(store.delete).not.toHaveBeenCalled();

    await expect(
      harness.callRpc("createDownloadUrl", { key: "private/secret.png" }),
    ).rejects.toThrow("rpc input validation failed");
  });

  it("refuses to overwrite an existing workspace download", async () => {
    const store = fakeStore();
    const { bb, harness } = createFakePluginHost({
      pluginId: "marketing-assets-r2",
      sdk: {
        files: {
          write: async () => ({ outcome: "conflict" as const }),
        },
      },
    });
    registerMarketingAssetsPlugin(bb, status, store);

    await expect(
      harness.runCli(
        ["download", "marketing-assets/id-image.png", "--out", "existing.png"],
        { cwd: "/workspace" },
      ),
    ).resolves.toMatchObject({
      exitCode: 1,
      stderr: "refusing to overwrite existing file: /workspace/existing.png",
    });
  });

  it("rejects invalid list flags before calling R2", async () => {
    const store = fakeStore();
    const { bb, harness } = createFakePluginHost({
      pluginId: "marketing-assets-r2",
    });
    registerMarketingAssetsPlugin(bb, status, store);

    await expect(
      harness.runCli(["list", "--limit", "0"]),
    ).resolves.toMatchObject({
      exitCode: 2,
      stderr: "--limit must be an integer from 1 to 250",
    });
    await expect(harness.runCli(["list", "--unknown"])).resolves.toMatchObject({
      exitCode: 1,
      stderr: "unknown flag: --unknown",
    });
    expect(store.list).not.toHaveBeenCalled();
  });
});
