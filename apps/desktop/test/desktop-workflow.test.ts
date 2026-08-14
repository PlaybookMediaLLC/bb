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
      steps: WorkflowStep[];
      strategy: {
        matrix: {
          arch: string[];
        };
      };
    };
    publish: {
      steps: WorkflowStep[];
    };
  };
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
});
