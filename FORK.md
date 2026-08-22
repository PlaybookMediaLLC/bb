# Fork development rules (marketing-harness)

This repo is a PlaybookMediaLLC fork of get-bb/bb. It ships the desktop app as
"marketing-harness". bb runs locally as the operator cockpit. The marketing
domain of record lives in the screenshot-studio cloud product. Upstream
conventions live in `AGENTS.md`.

## Keep the fork delta near zero

1. Build marketing features as plugins in `plugins/` and as skills. Call the
   screenshot-studio API for domain data. Do not edit kernel packages for fork
   features.
2. Do not reformat upstream files. Do not fix upstream style. Send real fixes
   upstream as PRs.
3. The fork owns only: release and packaging config, the sync workflow,
   `strategy.md`, and this file.

## Fork invariants

Guard tests pin these choices. A merge that breaks them took upstream's side
by mistake.

- GitHub-hosted runners only (`ubuntu-latest`, `ubuntu-22.04`, `macos-15`,
  `macos-15-intel`, `macos-latest`). Never Blacksmith runners. They queue
  forever in this org.
- Desktop builds ship both macOS architectures (arm64 + x64) on native
  runners, selected by the `desktop:build:mac:*` CLI flags. The
  electron-builder config carries no arch pin.
- Nightly desktop jobs depend only on `publish` (`needs: publish`). They stay
  decoupled from npm publish authorization.
- Naming: marketing-harness artifacts and the
  `com.playbookmedia.marketing-harness` app identity.
- The guards: `apps/desktop/test/desktop-workflow.test.ts` and
  `apps/desktop/test/electron-builder-config.test.ts`.

## Upstream sync

`.github/workflows/sync-upstream.yml` merges get-bb/bb main into the
`upstream` branch every night and opens a PR against main.

Resolve merge conflicts by class:

1. Runners, architectures, naming, nightly decoupling: the fork wins.
2. New upstream features, package renames, dependency bumps: upstream wins.
3. After every merge, run `grep -rn blacksmith .github/`. The merge can pull
   Blacksmith runners in through files that did not conflict.
4. Run `pnpm --dir apps/desktop run test` before you push the merge. The guard
   tests catch a wrong resolution.

## Release PRs

Every push to `main` runs release-please and opens or updates one patch release
PR. The PR keeps `bb-app` and the desktop version locked together and prepares
the root changelog. The workflow dispatches CI explicitly because a PR created
with `GITHUB_TOKEN` does not trigger another workflow run.

Merging the release PR creates `marketing-harness-v<version>` and dispatches the
existing stable desktop workflow. Reviewers must complete the web and app
changelog metadata named in the release PR before merging it.
