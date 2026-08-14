import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bbDesktopVersionFeedSchema } from "@bb/desktop-contract";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { mergeMacosReleaseArtifacts } from "../scripts/merge-macos-release-artifacts.mjs";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((tempDir) => rm(tempDir, { force: true, recursive: true })),
  );
});

async function createArchitectureArtifacts(root: string, arch: string) {
  const sourceDir = join(root, arch);
  await mkdir(sourceDir, { recursive: true });

  for (const extension of ["dmg", "dmg.blockmap", "zip", "zip.blockmap"]) {
    await writeFile(
      join(sourceDir, `marketing-harness-1.2.3-${arch}.${extension}`),
      `${arch}-${extension}`,
    );
  }
  await writeFile(join(sourceDir, "latest-mac.yml"), "ignored: true\n");
  await writeFile(join(sourceDir, "desktop-version.json"), "{}\n");

  return sourceDir;
}

describe("mergeMacosReleaseArtifacts", () => {
  it("combines both architectures into one updater feed", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-macos-release-merge-"));
    tempDirs.push(root);
    const arm64Dir = await createArchitectureArtifacts(root, "arm64");
    const x64Dir = await createArchitectureArtifacts(root, "x64");
    const outputDir = join(root, "combined");

    const result = await mergeMacosReleaseArtifacts({
      arm64Dir,
      outputDir,
      releaseChannel: "latest",
      releaseDate: "2026-08-14T00:00:00.000Z",
      version: "1.2.3",
      x64Dir,
    });

    expect(result.updateMetadataFileName).toBe("latest-mac.yml");
    expect(result.copiedArtifactNames).toHaveLength(8);

    const updateMetadata = parseYaml(
      await readFile(join(outputDir, "latest-mac.yml"), "utf8"),
    );
    expect(
      updateMetadata.files.map((file: { url: string }) => file.url),
    ).toEqual([
      "marketing-harness-1.2.3-arm64.zip",
      "marketing-harness-1.2.3-x64.zip",
    ]);
    expect(updateMetadata.path).toBe("marketing-harness-1.2.3-x64.zip");
    expect(updateMetadata.sha512).toBe(updateMetadata.files[1].sha512);

    const versionFeed = bbDesktopVersionFeedSchema.parse(
      JSON.parse(
        await readFile(join(outputDir, "desktop-version.json"), "utf8"),
      ),
    );
    expect(versionFeed.files).toEqual(updateMetadata.files);
    expect(versionFeed.path).toBe(updateMetadata.path);
    expect(versionFeed.platform).toBe("macos");
    expect(versionFeed.version).toBe("1.2.3");
  });

  it("rejects a release missing either architecture", async () => {
    const root = await mkdtemp(join(tmpdir(), "bb-macos-release-merge-"));
    tempDirs.push(root);
    const arm64Dir = await createArchitectureArtifacts(root, "arm64");
    const x64Dir = await createArchitectureArtifacts(root, "other");

    await expect(
      mergeMacosReleaseArtifacts({
        arm64Dir,
        outputDir: join(root, "combined"),
        releaseChannel: "latest",
        version: "1.2.3",
        x64Dir,
      }),
    ).rejects.toThrow("Expected one x64 macOS zip artifact");
  });
});
