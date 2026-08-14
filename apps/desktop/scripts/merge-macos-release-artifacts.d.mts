export type MergeMacosReleaseArtifactsOptions = {
  arm64Dir: string;
  outputDir: string;
  releaseChannel: "latest" | "nightly";
  releaseDate?: string;
  version: string;
  x64Dir: string;
};

export type MergeMacosReleaseArtifactsResult = {
  copiedArtifactNames: string[];
  updateMetadataFileName: "latest-mac.yml" | "nightly-mac.yml";
};

export function mergeMacosReleaseArtifacts(
  options: MergeMacosReleaseArtifactsOptions,
): Promise<MergeMacosReleaseArtifactsResult>;
