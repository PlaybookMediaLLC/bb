import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";

type WorkflowStep = {
  name?: string;
  run?: string;
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
});
