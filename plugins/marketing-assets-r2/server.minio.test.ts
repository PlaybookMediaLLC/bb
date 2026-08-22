import { describe, expect, it } from "vitest";
import {
  DeleteObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { createFakePluginHost } from "@get-bb/plugin-sdk/testing";
import { z } from "zod";
import plugin from "./server";

const endpoint = process.env.BB_TEST_MINIO_ENDPOINT;
const accessKeyId = process.env.BB_TEST_MINIO_ACCESS_KEY;
const secretAccessKey = process.env.BB_TEST_MINIO_SECRET_KEY;
const bucket = process.env.BB_TEST_MINIO_BUCKET;
const minioSettings =
  endpoint !== undefined &&
  accessKeyId !== undefined &&
  secretAccessKey !== undefined &&
  bucket !== undefined
    ? { endpoint, accessKeyId, secretAccessKey, bucket }
    : null;

const uploadSchema = z.object({
  key: z.string().startsWith("marketing-assets/"),
});
const listSchema = z.object({
  assets: z.array(
    z.object({
      key: z.string(),
      name: z.string(),
      sizeBytes: z.number().int().nonnegative(),
      lastModifiedAt: z.number().int().nonnegative().nullable(),
      etag: z.string().nullable(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

function createMinioHost(content: Uint8Array) {
  if (!minioSettings) throw new Error("MinIO test settings are missing");
  const writes: string[] = [];
  const host = createFakePluginHost({
    pluginId: "marketing-assets-r2",
    settings: minioSettings,
    sdk: {
      files: {
        read: async () => ({
          content: Buffer.from(content).toString("base64"),
          contentEncoding: "base64" as const,
          sha256: "unused",
        }),
        write: async (args) => {
          writes.push(args.content);
          return { outcome: "written" as const, sha256: "written" };
        },
      },
    },
  });
  return { ...host, writes };
}

describe.skipIf(minioSettings === null)("Marketing Assets with MinIO", () => {
  it("paginates real objects and completes the CLI lifecycle", async () => {
    const { bb, harness, writes } = createMinioHost(
      Buffer.from("minio-integration"),
    );
    const remainingKeys = new Set<string>();
    await plugin(bb);

    try {
      for (const fileName of ["campaign-a.txt", "campaign-b.txt"]) {
        const upload = await harness.runCli(["upload", fileName, "--json"], {
          cwd: "/workspace",
        });
        expect(upload).toMatchObject({ exitCode: 0, stderr: "" });
        remainingKeys.add(uploadSchema.parse(JSON.parse(upload.stdout)).key);
      }

      const firstPageResult = await harness.runCli([
        "list",
        "--limit",
        "1",
        "--json",
      ]);
      expect(firstPageResult).toMatchObject({ exitCode: 0, stderr: "" });
      const firstPage = listSchema.parse(JSON.parse(firstPageResult.stdout));
      expect(firstPage.assets).toHaveLength(1);
      expect(firstPage.nextCursor).toBeTypeOf("string");

      const secondPageResult = await harness.runCli([
        "list",
        "--limit",
        "1",
        "--cursor",
        firstPage.nextCursor ?? "",
        "--json",
      ]);
      expect(secondPageResult).toMatchObject({ exitCode: 0, stderr: "" });
      const secondPage = listSchema.parse(JSON.parse(secondPageResult.stdout));
      expect(
        [...firstPage.assets, ...secondPage.assets]
          .map((asset) => asset.key)
          .sort(),
      ).toEqual([...remainingKeys].sort());

      const key = [...remainingKeys][0];
      if (!key) throw new Error("MinIO upload did not return a key");
      const signedUrl = await harness.runCli(["url", key]);
      expect(signedUrl).toMatchObject({ exitCode: 0, stderr: "" });
      const response = await fetch(signedUrl.stdout);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("minio-integration");

      await expect(
        harness.runCli(["download", key, "--out", "downloaded.txt"], {
          cwd: "/workspace",
        }),
      ).resolves.toMatchObject({
        exitCode: 0,
        stdout: "/workspace/downloaded.txt",
      });
      expect(writes).toEqual([
        Buffer.from("minio-integration").toString("base64"),
      ]);

      for (const uploadedKey of [...remainingKeys]) {
        await expect(
          harness.runCli(["delete", uploadedKey, "--yes"]),
        ).resolves.toMatchObject({ exitCode: 0, stderr: "" });
        remainingKeys.delete(uploadedKey);
      }
      const afterDelete = listSchema.parse(
        JSON.parse((await harness.runCli(["list", "--json"])).stdout),
      );
      expect(afterDelete.assets).toHaveLength(0);
    } finally {
      for (const key of remainingKeys) {
        await harness.runCli(["delete", key, "--yes"]);
      }
    }
  });

  it("completes the same lifecycle through the SDK RPC contract", async () => {
    const { bb, harness, writes } = createMinioHost(
      Buffer.from("rpc-integration"),
    );
    let key: string | null = null;
    await plugin(bb);

    try {
      key = uploadSchema.parse(
        await harness.callRpc("uploadFromWorkspace", {
          hostId: null,
          rootPath: "/workspace",
          path: "rpc.txt",
          contentType: "text/plain",
        }),
      ).key;

      const listed = listSchema.parse(
        await harness.callRpc("listAssets", { cursor: null, limit: 250 }),
      );
      expect(listed.assets.map((asset) => asset.key)).toContain(key);

      const signed = z
        .object({ url: z.url(), expiresAt: z.number().int().positive() })
        .parse(await harness.callRpc("createDownloadUrl", { key }));
      const response = await fetch(signed.url);
      expect(response.status).toBe(200);
      await expect(response.text()).resolves.toBe("rpc-integration");

      await expect(
        harness.callRpc("downloadToWorkspace", {
          hostId: null,
          rootPath: "/workspace",
          path: "rpc-downloaded.txt",
          key,
        }),
      ).resolves.toEqual({
        key,
        path: "/workspace/rpc-downloaded.txt",
        sizeBytes: Buffer.byteLength("rpc-integration"),
      });
      expect(writes).toEqual([
        Buffer.from("rpc-integration").toString("base64"),
      ]);

      await expect(harness.callRpc("deleteAsset", { key })).resolves.toEqual({
        deleted: true,
        key,
      });
      key = null;
    } finally {
      if (key) await harness.runCli(["delete", key, "--yes"]);
    }
  });

  it("preserves binary bytes, content type, and object metadata", async () => {
    const body = Uint8Array.from([0, 255, 1, 128, 10, 13, 42]);
    const { bb, harness, writes } = createMinioHost(body);
    let key: string | null = null;
    await plugin(bb);

    try {
      const upload = await harness.runCli(
        [
          "upload",
          "creative.bin",
          "--content-type",
          "application/x-bb-test",
          "--json",
        ],
        { cwd: "/workspace" },
      );
      expect(upload).toMatchObject({ exitCode: 0, stderr: "" });
      key = uploadSchema.parse(JSON.parse(upload.stdout)).key;

      const listed = listSchema.parse(
        JSON.parse((await harness.runCli(["list", "--json"])).stdout),
      );
      expect(listed.assets).toContainEqual(
        expect.objectContaining({
          key,
          sizeBytes: body.byteLength,
          lastModifiedAt: expect.any(Number),
          etag: expect.any(String),
        }),
      );

      const signedUrl = await harness.runCli(["url", key]);
      const response = await fetch(signedUrl.stdout);
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe(
        "application/x-bb-test",
      );
      expect(new Uint8Array(await response.arrayBuffer())).toEqual(body);

      await expect(
        harness.runCli(["download", key, "--out", "creative.bin"], {
          cwd: "/workspace",
        }),
      ).resolves.toMatchObject({ exitCode: 0, stderr: "" });
      expect(writes).toEqual([Buffer.from(body).toString("base64")]);
    } finally {
      if (key) await harness.runCli(["delete", key, "--yes"]);
    }
  });

  it("does not list objects outside the marketing-assets prefix", async () => {
    if (!minioSettings) throw new Error("MinIO test settings are missing");
    const client = new S3Client({
      region: "us-east-1",
      endpoint: minioSettings.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: minioSettings.accessKeyId,
        secretAccessKey: minioSettings.secretAccessKey,
      },
    });
    const key = "outside-plugin-scope.txt";
    await client.send(
      new PutObjectCommand({
        Bucket: minioSettings.bucket,
        Key: key,
        Body: "outside",
      }),
    );

    try {
      const { bb, harness } = createMinioHost(Buffer.from("unused"));
      await plugin(bb);
      const listed = listSchema.parse(
        await harness.callRpc("listAssets", { cursor: null, limit: 250 }),
      );
      expect(listed.assets.map((asset) => asset.key)).not.toContain(key);
    } finally {
      await client.send(
        new DeleteObjectCommand({ Bucket: minioSettings.bucket, Key: key }),
      );
      client.destroy();
    }
  });

  it("does not write a workspace file when the object is missing", async () => {
    const { bb, harness, writes } = createMinioHost(Buffer.from("unused"));
    await plugin(bb);

    await expect(
      harness.callRpc("downloadToWorkspace", {
        hostId: null,
        rootPath: "/workspace",
        path: "missing.bin",
        key: "marketing-assets/does-not-exist.bin",
      }),
    ).rejects.toThrow();
    expect(writes).toEqual([]);
  });
});
