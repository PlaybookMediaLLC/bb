import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createDesktopReleaseConfig,
  resolveDesktopReleaseChannel,
} from "./desktop-release-channel.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const desktopPackageRoot = resolve(scriptDirectory, "..");
const copiedArtifactExtensions = new Set([".blockmap", ".dmg", ".zip"]);

async function createFileDescriptor(filePath) {
  const hash = createHash("sha512");
  const stream = createReadStream(filePath);

  for await (const chunk of stream) {
    hash.update(chunk);
  }

  return {
    sha512: hash.digest("base64"),
    size: (await stat(filePath)).size,
    url: basename(filePath),
  };
}

function serializeUpdateMetadata(metadata) {
  const lines = [`version: ${JSON.stringify(metadata.version)}`, "files:"];

  for (const file of metadata.files) {
    lines.push(
      `  - url: ${JSON.stringify(file.url)}`,
      `    sha512: ${JSON.stringify(file.sha512)}`,
      `    size: ${file.size}`,
    );
  }

  lines.push(
    `path: ${JSON.stringify(metadata.path)}`,
    `sha512: ${JSON.stringify(metadata.sha512)}`,
    `releaseDate: ${JSON.stringify(metadata.releaseDate)}`,
    "",
  );

  return lines.join("\n");
}

async function copyArchitectureArtifacts(sourceDir, outputDir, seenNames) {
  const entries = await readdir(sourceDir, { withFileTypes: true });
  const copiedPaths = [];

  for (const entry of entries) {
    if (!entry.isFile() || !copiedArtifactExtensions.has(extname(entry.name))) {
      continue;
    }
    if (seenNames.has(entry.name)) {
      throw new Error(`Duplicate macOS release artifact: ${entry.name}`);
    }

    seenNames.add(entry.name);
    const destinationPath = join(outputDir, entry.name);
    await copyFile(join(sourceDir, entry.name), destinationPath);
    copiedPaths.push(destinationPath);
  }

  return copiedPaths;
}

function requireArchitectureZip(descriptors, arch) {
  const suffix = `-${arch}.zip`;
  const matches = descriptors.filter((file) => file.url.endsWith(suffix));
  if (matches.length !== 1) {
    throw new Error(
      `Expected one ${arch} macOS zip artifact ending in ${suffix}, found ${matches.length}.`,
    );
  }
  return matches[0];
}

export async function mergeMacosReleaseArtifacts({
  arm64Dir,
  outputDir,
  releaseChannel,
  releaseDate = new Date().toISOString(),
  version,
  x64Dir,
}) {
  await mkdir(outputDir, { recursive: true });
  const seenNames = new Set();
  const copiedPaths = [
    ...(await copyArchitectureArtifacts(arm64Dir, outputDir, seenNames)),
    ...(await copyArchitectureArtifacts(x64Dir, outputDir, seenNames)),
  ];
  const zipPaths = copiedPaths.filter(
    (filePath) => extname(filePath) === ".zip",
  );
  const files = await Promise.all(zipPaths.map(createFileDescriptor));
  files.sort((left, right) => left.url.localeCompare(right.url));

  requireArchitectureZip(files, "arm64");
  const primaryFile = requireArchitectureZip(files, "x64");
  const releaseConfig = createDesktopReleaseConfig(releaseChannel);
  const updateMetadata = {
    files,
    path: primaryFile.url,
    releaseDate,
    sha512: primaryFile.sha512,
    version,
  };
  const updateMetadataFileName = releaseConfig.updateMetadataFileNames.macos;

  await writeFile(
    join(outputDir, updateMetadataFileName),
    serializeUpdateMetadata(updateMetadata),
    "utf8",
  );
  await writeFile(
    join(outputDir, "desktop-version.json"),
    `${JSON.stringify(
      {
        channel: releaseChannel,
        files,
        minimumSystemVersion: null,
        path: primaryFile.url,
        platform: "macos",
        releaseDate,
        releaseName: `${releaseConfig.applicationName} desktop ${version}`,
        releaseNotes: null,
        schemaVersion: 1,
        sha512: primaryFile.sha512,
        stagingPercentage: null,
        version,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  return {
    copiedArtifactNames: copiedPaths.map((filePath) => basename(filePath)).sort(),
    updateMetadataFileName,
  };
}

async function main() {
  const [arm64Dir, x64Dir, outputDir] = process.argv.slice(2);
  if (!arm64Dir || !x64Dir || !outputDir) {
    throw new Error(
      "Usage: merge-macos-release-artifacts.mjs <arm64-dir> <x64-dir> <output-dir>",
    );
  }

  const packageJson = JSON.parse(
    await readFile(join(desktopPackageRoot, "package.json"), "utf8"),
  );
  if (
    typeof packageJson.version !== "string" ||
    packageJson.version.length === 0
  ) {
    throw new Error("apps/desktop/package.json must define a version");
  }

  const result = await mergeMacosReleaseArtifacts({
    arm64Dir: resolve(arm64Dir),
    outputDir: resolve(outputDir),
    releaseChannel: resolveDesktopReleaseChannel(process.env),
    version: packageJson.version,
    x64Dir: resolve(x64Dir),
  });
  process.stdout.write(
    `Merged ${result.copiedArtifactNames.length} macOS artifacts and wrote ${result.updateMetadataFileName}.\n`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
