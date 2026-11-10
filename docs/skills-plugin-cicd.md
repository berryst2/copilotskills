# GitHub skills to a Microsoft 365 plugin: onboarding and operations

This guide explains how to adopt this repository's working WIQD integration.
The repository owner reported a successful M365 Tools plugin update on
10 November 2026. Other repositories must qualify their own runner, account,
tenant permissions and runtime behavior.

## 1. Understand the destination and responsibilities

A Microsoft 365 Copilot plugin is an app package. Skills are components of that
package; they are not published as separate registry entries by this pipeline.
A declarative agent is optional. This repository packages skills registered in
the root manifest's `agentSkills` collection.

| Destination or operation | What this implementation does |
| --- | --- |
| Microsoft 365 organization catalog | Submits the plugin through `wiqd plugin publish`; tenant approval remains separate |
| Shared development deployment | Created during explicitly authorized bootstrap; not the same as catalog submission |
| Public Marketplace/AppSource | Not implemented; requires a separate publishing/certification process |
| GitHub Copilot CLI/Claude Code marketplace | A different artifact; installing the WIQD coding-assistant plugin does not distribute your M365 skills |

The [official plugin walkthrough][plugin-guide] explains the plugin lifecycle.
The [official pipeline guide][pipeline-guide] supplies **agent-project** examples,
not a ready-made skills-plugin pipeline. Do not copy its `wiqd agent` command
body unchanged into a plugin project. This repository uses `wiqd plugin` commands
and project-owned release controls.

## 2. Know what happens after a merge

```text
Skill pull request
  -> GitHub-hosted source checks and regression tests (no deployment secrets)
  -> merge into main
  -> trusted source checks on the self-hosted runner
  -> dev environment approval, if configured
  -> reserve an increasing app version in a Git tag
  -> stage a fresh plugin with every current skill
  -> WIQD source validation
  -> package ZIP and verify skill/resource bytes
  -> Microsoft TDP validation of the exported ZIP
  -> WIQD organization catalog submission
  -> tenant administrator approval and availability checks
```

Existing-app submission skips development provisioning. Bootstrap provisions
first. Both paths reuse the staged state for subsequent lifecycle operations.
WIQD publication builds its own upload; validating the exported ZIP does not
prove that publication uploads byte-identical ZIP bytes.

Relevant pushes to `main` and manual validation runs on `main` can deploy.
Relevant paths include skill categories, the plugin container, scripts,
dependency manifests and workflow files. Documentation-only changes do not
trigger these workflows. Direct pushes also deploy; use branch rules to require
PRs, reviews and successful checks if that is your policy.

## 3. Adopt the repository implementation

Start from this repository's files, not just one workflow. Retain:

| Component | Purpose |
| --- | --- |
| [Validation workflow](../.github/workflows/validate-plugin.yml) | PR/main routing and dependent release |
| [Packaging workflow](../.github/workflows/package-plugin.yml) | Runner, environment, version reservation, artifacts and cleanup |
| [Lifecycle script](../scripts/plugin.ps1) | Staging, registration, identity injection and WIQD operations |
| [Runner check](../scripts/check-wiqd.ps1) | Exact CLI version and existing human EULA acceptance |
| [Skill checker](../scripts/skills.mjs) | Source discovery and exact ZIP content verification |
| [Version allocator](../scripts/release-version.mjs) | Monotonic version selection |
| [Regression tests](../scripts/skills.test.mjs) | Local validation of the integration without live deployment |
| [Dependency manifest](../package.json) and [lockfile](../package-lock.json) | Reproducible checker/test dependencies |
| [Plugin container](../banking-skills/) | Descriptor, lifecycle YAML, manifest, icons and non-secret environment template |

For another repository:

1. Copy the components above together with their source skill directories.
   Never copy generated environment state, credential caches or real credentials.
2. Keep the existing names initially, or consistently update project paths,
   app display names, artifact names, tag prefix, concurrency group, environment
   name, workflow path checks and regression tests when renaming.
3. If your source layout differs, update the `categories` list in the skill
   checker, both workflow path filters and the associated test fixtures.
   Discovery currently expects one skill folder directly under each category.
   All configured categories must exist and retain at least one valid skill.
4. Review the container's manifest, icons and publisher details for your app.
   Preserve the app-ID placeholder; inject your own real identity at release time.
5. Review `m365agents.yml`: tenant publication uses `scope: tenant` and writes
   `M365_PUBLISHED_TITLE_ID` / `M365_PUBLISHED_APP_ID` separately from development
   provisioning IDs. CLI upgrades do not rewrite this lifecycle file.
6. Run the local checks below before enabling authenticated deployment.

This is a repository-owned integration, not an installed WIQD pipeline template.
Do not treat its PowerShell parameters or GitHub variables as native WIQD options.

### Skill format

For example, `legal/policy-review/SKILL.md`:

```markdown
---
name: policy-review
description: Review an internal policy against supplied requirements and identify evidence gaps.
---

Review the supplied policy and requirements. Cite supporting evidence,
identify missing information, and leave approval to the authorized reviewer.
```

Use a unique kebab-case folder/name of 1-64 characters and a description of
1-1024 characters. Include a nonempty body. Keep referenced resources inside
the skill folder. Complete folders are copied; symlinks, escaping links and
potential credential files are rejected.

The [official format reference][plugin-reference] also documents host limits.
For root-manifest Cowork skills it currently lists at most 20 companion files
per skill, 5 MB per companion and 10 MB across companions; `SKILL.md` is separate.
These are not the same limits as declarative-agent-only skills. The local
checker does not enforce every host limit or prove runtime compatibility.
Check the current reference before growing the bundle.

## 4. Prepare the runner once

Use a persistent Linux x64 runner registered with this repository and labels
`self-hosted`, `Linux`, `X64`. Restrict it to trusted main/release code; never run
untrusted PR code on the credential-bearing release runner.

The current integration pins **Node 24.15.0**, **WIQD 0.25.0** and requires
**PowerShell 7 or later**. The official site may describe newer releases.
Use the [official installation instructions][installation] during human setup,
but verify the exact repository pin before running releases; do not silently
replace it with `latest`. Upgrades require coordinated pin/test changes.
The coding-assistant marketplace plugin alone does not install the WIQD CLI.

Run these checks in an Ubuntu terminal as the **runner service account**:

```bash
whoami
node --version
command -v pwsh
pwsh -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion'
command -v wiqd
wiqd --version
dirname "$(command -v wiqd)"
wiqd eula status --json
```

If consent is required, a human must read the [WIQD EULA](https://aka.ms/wiqd/eula)
and, only if they agree, run `wiqd eula accept wiqd` interactively outside CI.
Never automate acceptance or copy another account's consent/authentication state.

The service may have a different PATH from SSH. Save the directory printed by
`dirname` as `WIQD_BIN_DIR` below. PowerShell itself must already be discoverable
by the runner service. See the [README runner instructions](../README.md#prepare-a-dedicated-runner)
for Ubuntu installation and service environment refresh.

## 5. Configure GitHub and Microsoft 365 once

In the target GitHub repository:

1. Open **Settings > Environments > New environment**, create `dev`, and restrict
   deployment branches to `main`.
2. Choose reviewers according to organizational policy. Required reviewers pause
   every release; approved unattended submission needs a policy without that gate.
3. Use **Environment secrets > Add environment secret** for the two secrets below.
4. Use **Environment variables > Add environment variable** for the variables below.
   These belong to this repository's `dev` environment, not merely your SSH shell.
5. Under **Settings > Actions > Runners**, confirm the prepared runner is online.
6. Ensure organization/repository policy permits the release job's `contents: write`
   and `actions: read` permissions. Allow creation of `banking-skills/dev/v*` tags,
   but protect existing reservation tags against deletion or movement.

| Name | Location | Value / when required |
| --- | --- | --- |
| `M365_ACCOUNT_NAME` | Environment secret | Release user's Microsoft 365 account |
| `M365_ACCOUNT_PASSWORD` | Environment secret | That account's password |
| `WIQD_BIN_DIR` | Environment variable | Absolute directory containing `wiqd`, if it is not already on the job PATH |
| `PLUGIN_DEVELOPER_NAME` | Environment variable | Real publisher/developer name |
| `PLUGIN_WEBSITE_URL` | Environment variable | Real absolute HTTPS website URL |
| `PLUGIN_PRIVACY_URL` | Environment variable | Real absolute HTTPS privacy URL |
| `PLUGIN_TERMS_URL` | Environment variable | Real absolute HTTPS terms URL |
| `TEAMS_APP_ID` | Environment variable | Actual nonzero GUID from provisioning; omit for new-app bootstrap |
| `M365_TITLE_ID` | Environment variable | Actual provisioning title ID; omit for new-app bootstrap |
| `M365_APP_ID` | Environment variable | Actual provisioning app ID; omit for new-app bootstrap |
| `PLUGIN_VERSION_FLOOR` | Environment variable | Confirmed highest uploaded version when onboarding an existing app or recovering version state |

Enter raw values without quotes, `NAME=` prefixes or surrounding whitespace.
Do not invent app IDs. The workflow injects `CI_ENABLED: 'true'` itself; there is
no additional GitHub variable to create for that flag.

### Authentication is a tenant decision

This implementation uses **username/password** authentication and rejects a
present `M365_REFRESH_TOKEN`. Passwords are not a recommendation to weaken MFA.
Confirm required delegated permissions, consent, Conditional Access and TDP
validation access with your tenant administrator. Successful source checks do
not prove cloud access. Do not run `wiqd auth login` in CI.

The [official authentication reference][pipeline-auth] also supports refresh-token
mode. Switching requires code/workflow changes: remove both password bindings
entirely, add protected `M365_REFRESH_TOKEN` and tenant GUID `M365_TENANT_ID`,
update the script's password-only checks and tests, and qualify the release.
Adding a token secret alone does not switch this repository's mode.
Bootstrap/renewal is a human private-terminal operation, not a workflow step.
Neither mode is app-only or managed-identity authentication.

## 6. Bootstrap a new app OR onboard an existing app

### New app: do this once

1. Put reviewed workflows on `main`. An automatic run before setup is complete
   may fail closed; do not interpret that as permission to invent identity values.
2. Ensure `TEAMS_APP_ID`, `M365_TITLE_ID` and `M365_APP_ID` are absent from `dev`.
3. Open **Actions > Package Microsoft 365 plugin > Run workflow**.
4. Select **main**, check **create_new_app**, leave **publish unchecked**, and
   leave **version_floor** empty. This explicitly creates cloud resources.
5. After success, open the run summary and download
   **banking-skills-provisioning-ids**. Extract its JSON and save all three values
   in the GitHub environment variables above.
6. For the first catalog submission, either merge a relevant skill PR or run
   **Package Microsoft 365 plugin** on `main` with **create_new_app unchecked**
   and **publish checked**.

### Existing app: do not create another

1. Obtain the actual three provisioning IDs from your previous receipt or app
   owner. Do not substitute publication IDs or generate random GUIDs.
2. Confirm the highest version already uploaded to Microsoft, including
   development and catalog attempts. Save it as `PLUGIN_VERSION_FLOOR`.
   If unknown, ask the app administrator before continuing.
3. Save the IDs and other GitHub settings, then merge a skill PR or manually
   run packaging with **create_new_app unchecked**, **publish checked**.

| Manual options | Behavior |
| --- | --- |
| New app checked, publish unchecked | Creates development/shared app, packages, saves IDs; no catalog submission |
| New app unchecked, publish checked | Reuses IDs, skips development provisioning, validates ZIP and submits |
| New app unchecked, publish unchecked | Updates/provisions development app and packages; **not an offline build** |
| New app checked, publish checked | Creates app then submits; prefer the two-stage bootstrap above for clearer recovery |

Normal automatic releases select existing-app submission. No per-merge manual
inputs or source-manifest version edits are required.

## 7. Operate, verify and recover

Each release reserves a higher version at the triggering commit before Microsoft
365 mutations. Failed attempts consume their reservation. Never delete tags,
reuse a version or move a reservation to another commit. If an external upload
overtakes the counter, raise `PLUGIN_VERSION_FLOOR` to the confirmed consumed
version. Artifacts are receipts, not the durable version database.

After a successful run, use **Actions > run summary > Artifacts**:

| Artifact | What to check |
| --- | --- |
| `banking-skills-release-version` | Reserved version, commit, run/attempt and tag |
| `banking-skills-provisioning-ids` | Non-secret development identity; retain for future releases |
| `banking-skills-plugin` | Verified ZIP and SHA-256 checksum; retained for 14 days |
| `banking-skills-publication` | Successful submission receipt with version and correlation ID |

Ask the tenant administrator to locate and review the submitted app in the
organization's Microsoft 365 app-management/catalog experience, approve it and
assign availability according to policy. Then test the approved plugin as an
intended user in the target M365 host. A submission receipt does not establish
approval, tenant-wide rollout or successful execution of every skill.

### Troubleshooting

| Symptom | Action |
| --- | --- |
| WIQD missing or wrong version | Check service-account PATH and `WIQD_BIN_DIR`; verify exact 0.25.0 installation |
| `spawnSync pwsh ENOENT` | Install PowerShell 7 and refresh/restart the runner service environment |
| EULA gate | Human reviews/accepts under the runner account outside CI; rerun only after status is accepted |
| Missing publisher value / invalid URL | Correct the `dev` environment variables; use real HTTPS URLs |
| Missing app IDs | Bootstrap once or retrieve actual existing IDs; never invent them |
| `PLUGIN_NOT_PROVISIONED` while packaging | Check raw stored GUID and updated staging script; duplicate assignments or missing final newlines must not corrupt staged state; do not blindly provision again |
| No shared version record | Existing app needs confirmed `PLUGIN_VERSION_FLOOR`; new app needs explicit bootstrap |
| Higher-version-required error | Confirm highest consumed Microsoft version and update floor; retain identity and reservation tags |
| Tag API permission error | Check release-job permissions and tag rules; stop before cloud mutation |
| Authentication / TDP failure | Resolve account permissions, consent or tenant policy; do not bypass MFA or switch credentials silently |
| Workflow waiting / no run | Check environment reviewers, runner availability, branch and path filters; README-only changes do not trigger deployment |
| Provision/publish failed after starting | Inspect remote app/version state before an authorized rerun; an error does not prove no mutation occurred |

The scripts stop on native failures, invalid/non-success JSON or failed package
checks. They do not automatically retry cloud operations. Staging cleanup removes
the per-run project, not the runner's human consent or authentication caches.
Never upload environment files, secret files or the complete workspace.

## 8. Local checks and other CI systems

From the repository root in PowerShell, with Node and PowerShell installed:

```powershell
npm ci
npm test
npm run check
```

These tests use mocked WIQD lifecycle behavior, not a live Microsoft deployment.
For optional WIQD source staging with the prepared CLI/EULA:

```powershell
.\scripts\plugin.ps1 -ProjectPath (Join-Path ([IO.Path]::GetTempPath()) ("skills-" + [guid]::NewGuid()))
```

This invocation has no `-Provision` or `-Publish`: it stages and source-validates,
but does not produce a deployable ZIP or mutate cloud resources. It leaves the
chosen staging folder for inspection; remove that specific folder when finished.

For Azure Pipelines or another automation service, preserve the same trust
boundaries, exact CLI pin, explicit project/environment, protected process-level
credentials, durable version reservation, serialization, identity persistence,
failure gates and receipts. GitHub `${{ secrets.NAME }}` bindings are not Azure
`$(NAME)` macros. The [official pipeline examples][pipeline-guide] explain those
provider-specific bindings; this repository ships GitHub Actions only.

## Official sources and version scope

Reviewed on 11 November 2026. This guide summarizes the official documentation
and distinguishes it from this repository's pinned 0.25.0 behavior. Recheck
command help, authentication contracts and host limits before upgrades.

- [WIQD overview](https://microsoft.github.io/wiqd/): plugins and their components.
- [Installation][installation]: CLI versus coding-assistant plugin setup.
- [Build a plugin][plugin-guide]: composition, provisioning and organization publication.
- [Plugin format reference][plugin-reference]: layout, skill metadata and host limits.
- [CI/CD setup][pipeline-guide]: agent-project examples and reusable pipeline principles.
- [Pipeline authentication][pipeline-auth]: supported modes, policy and renewal.
- [CLI reference](https://microsoft.github.io/wiqd/cli/reference/): command options.

[installation]: https://microsoft.github.io/wiqd/getting-started/installation/
[plugin-guide]: https://microsoft.github.io/wiqd/getting-started/build-a-plugin/
[plugin-reference]: https://microsoft.github.io/wiqd/getting-started/plugin-reference/
[pipeline-guide]: https://microsoft.github.io/wiqd/getting-started/ci-cd-pipelines/
[pipeline-auth]: https://microsoft.github.io/wiqd/getting-started/ci-cd-authentication/
