import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

type WorkflowStep = {
  env?: Record<string, unknown>;
  if?: string;
  name?: string;
  run?: string;
  uses?: string;
  with?: Record<string, unknown>;
};

type DesktopWorkflow = {
  jobs: {
    macos: {
      "runs-on": string;
      steps: WorkflowStep[];
      strategy: {
        matrix: {
          arch: string[];
          include: Array<{
            arch: string;
            host_arch: string;
            runner: string;
          }>;
        };
      };
    };
    publish: {
      steps: WorkflowStep[];
    };
  };
};

type NightlyWorkflow = {
  env: {
    RELEASE_DRY_RUN: string;
  };
  jobs: {
    "nightly-desktop-linux": {
      needs: string;
    };
    "nightly-desktop-macos": {
      needs: string;
    };
  };
  "run-name": string;
};

type ReleasePleaseWorkflow = {
  jobs: {
    "release-please": {
      steps: WorkflowStep[];
    };
  };
  on: {
    push: {
      branches: string[];
    };
  };
  permissions: Record<string, string>;
};

const repositoryRoot = resolve(process.cwd(), "..", "..");

async function readDesktopWorkflow(): Promise<DesktopWorkflow> {
  return parseYaml(
    await readFile(
      resolve(repositoryRoot, ".github/workflows/build-desktop.yml"),
      "utf8",
    ),
  ) as DesktopWorkflow;
}

async function readNightlyWorkflow(): Promise<NightlyWorkflow> {
  return parseYaml(
    await readFile(
      resolve(repositoryRoot, ".github/workflows/publish-bb-app.yml"),
      "utf8",
    ),
  ) as NightlyWorkflow;
}

async function readReleasePleaseWorkflow(): Promise<ReleasePleaseWorkflow> {
  return parseYaml(
    await readFile(
      resolve(repositoryRoot, ".github/workflows/release-please.yml"),
      "utf8",
    ),
  ) as ReleasePleaseWorkflow;
}

async function readRepositoryJson(path: string) {
  return JSON.parse(await readFile(resolve(repositoryRoot, path), "utf8"));
}

function requireStep(steps: WorkflowStep[], name: string): WorkflowStep {
  const step = steps.find((candidate) => candidate.name === name);
  if (!step) {
    throw new Error(`Missing workflow step: ${name}`);
  }
  return step;
}

describe("desktop release workflow", () => {
  it("signs and notarizes macOS architectures in parallel", async () => {
    const workflow = await readDesktopWorkflow();
    expect(workflow.jobs.macos.strategy.matrix.arch).toEqual(["arm64", "x64"]);
    expect(workflow.jobs.macos["runs-on"]).toBe("${{ matrix.runner }}");
    expect(workflow.jobs.macos.strategy.matrix.include).toEqual([
      { arch: "arm64", host_arch: "arm64", runner: "macos-15" },
      { arch: "x64", host_arch: "x86_64", runner: "macos-15-intel" },
    ]);

    const packageStep = requireStep(
      workflow.jobs.macos.steps,
      "Package ${{ matrix.arch }} desktop artifacts",
    );
    expect(packageStep.run).toContain("desktop:build:mac:${{ matrix.arch }}");
    expect(packageStep.run).not.toContain("--force");

    const uploadStep = requireStep(
      workflow.jobs.macos.steps,
      "Upload ${{ matrix.arch }} desktop workflow artifacts",
    );
    expect(uploadStep.with?.name).toBe(
      "marketing-harness-desktop-macos-${{ matrix.arch }}",
    );
  });

  it("validates every Apple signing secret before packaging", async () => {
    const workflow = await readDesktopWorkflow();
    const validationStep = requireStep(
      workflow.jobs.macos.steps,
      "Validate macOS signing secrets",
    );
    const packageStep = requireStep(
      workflow.jobs.macos.steps,
      "Package ${{ matrix.arch }} desktop artifacts",
    );

    const expectedSecrets = {
      APPLE_APP_PASSWORD: "${{ secrets.APPLE_APP_PASSWORD }}",
      APPLE_ID: "${{ secrets.APPLE_ID }}",
      APPLE_TEAM_ID: "${{ secrets.APPLE_TEAM_ID }}",
      MACOS_CERTIFICATE_NAME: "${{ secrets.MACOS_CERTIFICATE_NAME }}",
      MACOS_CERTIFICATE_P12: "${{ secrets.MACOS_CERTIFICATE_P12 }}",
      MACOS_CERTIFICATE_PASSWORD: "${{ secrets.MACOS_CERTIFICATE_PASSWORD }}",
    };

    expect(validationStep.env).toEqual(expectedSecrets);
    for (const secretName of Object.keys(expectedSecrets)) {
      expect(validationStep.run).toContain(`"${secretName}"`);
    }
    expect(packageStep.env).toEqual({
      APPLE_APP_SPECIFIC_PASSWORD: "${{ secrets.APPLE_APP_PASSWORD }}",
      APPLE_ID: "${{ secrets.APPLE_ID }}",
      APPLE_TEAM_ID: "${{ secrets.APPLE_TEAM_ID }}",
      CSC_KEY_PASSWORD: "${{ secrets.MACOS_CERTIFICATE_PASSWORD }}",
      CSC_LINK: "${{ secrets.MACOS_CERTIFICATE_P12 }}",
      CSC_NAME: "${{ secrets.MACOS_CERTIFICATE_NAME }}",
    });
  });

  it("recombines architecture metadata before a stable publish", async () => {
    const workflow = await readDesktopWorkflow();
    const mergeStep = requireStep(
      workflow.jobs.publish.steps,
      "Merge macOS architecture artifacts",
    );

    expect(mergeStep.run).toContain("merge-macos-release-artifacts.mjs");
    expect(mergeStep.run).toContain("release/macos/arm64");
    expect(mergeStep.run).toContain("release/macos/x64");
    expect(mergeStep.run).toContain("release/macos/combined");
  });

  it("does not require npm publish authorization for scheduled desktop nightlies", async () => {
    const workflow = await readNightlyWorkflow();

    expect(workflow["run-name"]).toContain(
      "Build marketing-harness desktop nightly",
    );
    expect(workflow.env.RELEASE_DRY_RUN).toBe(
      "${{ github.event_name == 'schedule' && 'true' || inputs.dry_run }}",
    );
    expect(workflow.jobs["nightly-desktop-macos"].needs).toBe("publish");
    expect(workflow.jobs["nightly-desktop-linux"].needs).toBe("publish");
  });

  it("opens a checked release PR after main changes and publishes it through the stable workflow", async () => {
    const workflow = await readReleasePleaseWorkflow();
    const releaseStep = requireStep(
      workflow.jobs["release-please"].steps,
      "Prepare release PR or release",
    );
    const checksStep = requireStep(
      workflow.jobs["release-please"].steps,
      "Run checks for release PR",
    );
    const publishStep = requireStep(
      workflow.jobs["release-please"].steps,
      "Publish stable desktop release",
    );
    const config = await readRepositoryJson("release-please-config.json");
    const manifest = await readRepositoryJson(".release-please-manifest.json");
    const bbAppPackage = await readRepositoryJson(
      "packages/bb-app/package.json",
    );
    const desktopPackage = await readRepositoryJson(
      "apps/desktop/package.json",
    );

    expect(workflow.on.push.branches).toEqual(["main"]);
    expect(workflow.permissions).toMatchObject({
      actions: "write",
      contents: "write",
      "pull-requests": "write",
    });
    expect(releaseStep.uses).toBe(
      "googleapis/release-please-action@45996ed1f6d02564a971a2fa1b5860e934307cf7",
    );
    expect(checksStep.if).toContain("prs_created");
    expect(checksStep.run).toContain("gh workflow run ci.yml");
    expect(checksStep.run).toContain("gh workflow run version-lockstep.yml");
    expect(publishStep.if).toContain("release_created");
    expect(publishStep.run).toContain("gh workflow run build-desktop.yml");
    expect(publishStep.run).toContain("release_channel=stable");
    expect(config.packages["."]).toMatchObject({
      component: "marketing-harness",
      versioning: "always-bump-patch",
      "include-component-in-tag": true,
      "include-v-in-tag": true,
      "tag-separator": "-",
      "changelog-path": "CHANGELOG.md",
    });
    expect(config.packages["."]["extra-files"]).toEqual([
      {
        type: "json",
        path: "packages/bb-app/package.json",
        jsonpath: "$.version",
      },
      {
        type: "json",
        path: "apps/desktop/package.json",
        jsonpath: "$.version",
      },
    ]);
    expect(config.packages["."]["pull-request-footer"]).toContain(
      "AGENT GENERATED",
    );
    const repositoryPackage = await readRepositoryJson("package.json");
    expect(manifest["."]).toBe(repositoryPackage.version);
    expect(manifest["."]).toBe(bbAppPackage.version);
    expect(manifest["."]).toBe(desktopPackage.version);
  });
});
