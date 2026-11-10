# Banking skills plugin

Package skills maintained in GitHub as a Microsoft 365 Copilot plugin and submit
updates to your organization's catalog using WIQD.

**Start here:** [End-to-end onboarding and automation guide](docs/skills-plugin-cicd.md).
It covers a new repository, runner preparation, GitHub configuration, first-time
bootstrap, recurring releases, troubleshooting and official WIQD references.
The sections below describe this repository's implementation and operating rules.

Here, "Microsoft plugin registry" means the **Microsoft 365 organization catalog**.
This pipeline does not publish to the public Marketplace/AppSource or to a
coding-assistant plugin marketplace. Catalog submission still needs tenant
administrator approval.

The `legal`, `lending`, `operations` and `technology` folders are the source of
truth. Each skill folder needs a unique kebab-case name matching its YAML
frontmatter, a description and a nonempty `SKILL.md` body. Keep supporting files
inside that skill folder. Symlinks, escaping Markdown resources and potential
credential files are rejected.

`banking-skills` is a WIQD-generated plugin container. The release job stages a fresh copy,
registers every source skill using WIQD and copies complete skill folders into
`appPackage/skills/<name>`. Do not maintain duplicate skills in the container.

## Continuous integration

`Validate banking skill sources` runs on relevant pull requests and pushes to
`main`, and can also be run manually on `main`. Pull-request checks run on
GitHub-hosted Ubuntu. Pushes to `main` and manual runs on `main` use the
self-hosted runner labelled `self-hosted`, `Linux`, `X64`; manual runs on other
branches are skipped so they cannot execute unmerged code on that runner.
All runs use Node 24.15.0, run the source/ZIP checker tests and check all source folders.
The source-check job does not install/run WIQD, stage a plugin, or receive
deployment credentials. These are repository checks, not WIQD validation.

After successful source checks on a push or manual run on `main`, a dependent
deployment job calls the reusable packaging workflow. Subject to the `dev`
environment's approval gates, it reserves a higher app version, stages every
current skill, runs WIQD source validation, packages and verifies the ZIP,
validates that exact exported ZIP with Microsoft's TDP service, and runs
`wiqd plugin publish` to submit to the organization catalog for tenant
administrator approval. PRs never invoke deployment, and failed/skipped source
checks block it. The called workflow checks out the same triggering revision.
Existing-app submission does not rerun development provisioning.

The normal customer workflow is:

1. Add, edit or remove skill folders under the four source categories in a PR.
2. Let the secret-free PR checks pass, then merge into `main`.
3. GitHub automatically validates the merged revision, reserves its version,
   packages all current skills as one plugin and submits it using WIQD.
4. The tenant administrator handles Microsoft 365 catalog approval.

No manual workflow inputs, per-merge version edits, or fixed skill counts are
required after onboarding. Direct pushes touching the same paths also trigger
this flow; enforce PR-only merges through your repository's branch rules.
The source categories must each retain at least one valid skill.

Automatic deployment requires the three existing app IDs below. It never
creates a new app automatically. Bootstrap once using the manual packaging
workflow, save the IDs, then subsequent successful main validations deploy
automatically. Merging workflow-file changes also matches the deployment trigger;
README-only or documentation-only changes do not.
For an app already uploaded before adopting this pipeline, configure its
confirmed version baseline once as described below.

WIQD source validation does not provide full skill-only plugin validation.
Repository checks cover source structure and local Markdown links; release
checks verify every packaged skill/resource byte and reject unexpected ZIP
files. Neither proves runtime behavior or Marketplace acceptance.

## Packaging and organization catalog submission

### Prepare a dedicated runner

The release workflow targets a persistent Linux x64 self-hosted runner with
labels `self-hosted`, `Linux`, `X64`. No custom `wiqd` label is required.
Install Node 24.15.0, PowerShell 7 and WIQD 0.25.0 during
human runner setup, and ensure both `pwsh` and `wiqd` are on the runner service
account's PATH. PowerShell is also required by `npm test` in the source-check
job; these tests exercise the PowerShell scripts without live deployment.
Both workflows check PowerShell availability before running the tests or any
PowerShell steps. They do not install it or skip tests when it is missing.

If WIQD works over SSH but the job cannot find it, open **Settings > Environments >
dev > Environment variables** in GitHub and add `WIQD_BIN_DIR`. Set its value to
the absolute directory containing `wiqd`, not the executable itself. Obtain that 
directory in the working runner-account terminal with
`dirname "$(command -v wiqd)"`. For the current runner installation it is
`/home/azureuser/.local/lib/nodejs/node-v24.15.0-linux-x64/bin`.
The packaging workflow checks that the directory contains `wiqd` and adds it to
the PATH of subsequent steps via `GITHUB_PATH`, including preflight and staging.
It does not install WIQD, change the service account, or copy EULA/auth state.
The runner service account must have access to the installation and its own
accepted EULA. When this variable is omitted, the existing job PATH must already
resolve WIQD.

If a run reports `spawnSync pwsh ENOENT`, the runner service cannot locate
PowerShell. On the runner VM, follow Microsoft's
[Ubuntu PowerShell installation instructions](https://learn.microsoft.com/powershell/scripting/install/install-ubuntu)
for your Ubuntu version. Once the Microsoft package repository is configured,
install with `sudo apt-get update` and `sudo apt-get install -y powershell`.
Verify `command -v pwsh` and
`pwsh -NoProfile -NonInteractive -Command '$PSVersionTable.PSVersion'` as the
runner service account, not just your SSH login account.
If you changed PATH, refresh the runner's captured environment as that account
using `./env.sh` from its installation directory. Restart the runner service
from that directory with `sudo ./svc.sh stop`, then `sudo ./svc.sh start`.
Start a new workflow run using the updated commit. Installing PowerShell does
not require accepting the WIQD EULA again.

A human must review the [WIQD EULA](https://aka.ms/wiqd/eula) and, if they agree,
run `wiqd eula accept wiqd` interactively outside CI as that same account.
Confirm `wiqd eula status --json` reports `data.wiqd.state` as `accepted`.
Acceptance on your development machine does not establish acceptance on a
different runner account. CI never performs acceptance. The release job checks
the pinned version and existing acceptance before injecting credentials.

The WIQD version check is exact, not a minimum-version check. Keep the runner
on 0.25.0; a future upgrade needs a corresponding repository pin and test update.
After upgrading, verify EULA status under the runner account. If the CLI requires
renewed consent, a human must review and accept outside CI.

Keep this runner restricted to trusted source checks and release workflows on `main`; do not run
pull-request code on it. For a public repository, use your organization's
approved self-hosted-runner isolation and access controls. The hosted PR job
stays separate. Runner registration/security setup is an administrator task,
not performed by this repository.

The job uses a unique staging directory and removes its staged environment
files after success or failure. This does not reset the runner's EULA state or
remove its authentication caches.

### Configure the deployment environment

Create a GitHub environment named `dev`. Restrict it to `main` and configure
approval requirements according to your organization's release policy.
Required environment reviewers pause every release; fully unattended submission
requires an approved environment policy without that manual gate. Microsoft 365
catalog approval is separate and is not bypassed by this workflow.

Set these environment secrets:

- `M365_ACCOUNT_NAME`
- `M365_ACCOUNT_PASSWORD`

The workflow retains username/password mode; do not inject
`M365_REFRESH_TOKEN`. Tenant consent, MFA and Conditional Access still apply.
Credentials are injected only into the authenticated lifecycle step.

Set these environment variables to your real publisher details:

- `PLUGIN_DEVELOPER_NAME`
- `PLUGIN_WEBSITE_URL` (HTTPS)
- `PLUGIN_PRIVACY_URL` (HTTPS)
- `PLUGIN_TERMS_URL` (HTTPS)

Merge the workflows onto `main`, then select **Actions > Package Microsoft 365
plugin > Run workflow**. Select `main`.
The same workflow can also be called automatically after validation.

For a brand-new app's first deployment only, check `create_new_app` and leave
`publish` unchecked. Keep all three existing-app ID variables absent for this
bootstrap. This authorizes creation
of cloud resources in the shared `dev` environment. The scaffold's provision
lifecycle registers/updates the app and publishes a shared deployment; it is
not an offline ZIP build or tenant-catalog submission.
For manual runs, `publish` defaults to false (package only). Check it explicitly
to validate the exported ZIP with Microsoft and submit to the organization
catalog. Automatic deployment from the validation workflow sets `publish: true`.
With existing IDs and `publish: true`, the pipeline skips development
provisioning and packages, validates and submits directly. First-time creation
still provisions before packaging. With `publish: false`, the workflow
provisions/updates the development app before packaging; it is not offline.

### Automatic release versions

Every deployment attempt reserves a new `major.minor.patch` app version before
any Microsoft 365 changes, including attempts that fail. The reservation is a
Git tag named `banking-skills/dev/v<version>` pointing at the triggering commit.
Tags are durable and shared by automatic/manual releases across runners;
artifact expiry cannot reset the counter. The `banking-skills-dev` concurrency
group serializes allocation and deployment. The next version is greater than
the source manifest, reserved tags, and the configured baseline.
The source manifest is unchanged; the reserved version is applied to staging
and retained in the ZIP and publication receipt. No automatic retry is added.

For an existing app's one-time onboarding:

1. Check the highest version already uploaded to Microsoft for this app,
   including development and tenant-catalog versions. Teams Developer Portal
   and your organization's app administrator can help confirm it.
2. Open **Settings > Environments > dev > Environment variables**.
3. Add `PLUGIN_VERSION_FLOOR` with that confirmed version, not an arbitrary
   value (for example, `1.0.1` only if that is the actual highest version).
4. Save the three real app IDs and the other publisher/authentication settings.
5. Merge a skill PR into `main`. The release initializes its durable version
   record and submits automatically, with no `version_floor` workflow input.

For a brand-new app, the explicitly authorized manual `create_new_app`
bootstrap initializes from the source manifest. Save its generated IDs once;
ordinary merges thereafter reuse the app instead of creating duplicates.
The optional manual `version_floor` input remains available for migration or
recovery; normal automatic runs use `PLUGIN_VERSION_FLOOR` when configured.

The pipeline does not query Microsoft's current version and cannot safely
infer it from this error. If it is unknown, confirm it before initializing;
do not guess, change IDs, or create another app to bypass a version conflict.

Only the trusted release jobs receive `contents: write` to create reservation
tags using `GITHUB_TOKEN`. PR/source-check jobs stay read-only. Checkout does
not persist credentials, and no source commit or update to `main` is made.
Repository/organization rules must allow these release jobs to create tags
in the `banking-skills/dev/v*` namespace. Protect existing reservations against
deletion/movement; never delete or reuse them, including after failed releases.
`GITHUB_TOKEN` tag creation does not trigger another workflow run.
If tags are lost or a higher version is uploaded outside the pipeline, update
`PLUGIN_VERSION_FLOOR` to the confirmed highest consumed version before resuming.

Existing trusted artifact reservations from the previous implementation are
imported when selecting the next version, so migration does not reuse them.
New `banking-skills-release-version` artifacts are audit receipts only and may
expire without affecting version allocation. API, tag creation, receipt upload,
validation, and publication failures stop the release explicitly.

### Reuse the app identity and retrieve artifacts

Download `banking-skills-provisioning-ids` and save its three non-secret values
as environment variables `TEAMS_APP_ID`, `M365_TITLE_ID` and `M365_APP_ID`.
Enter raw values only: no surrounding quotes, whitespace or `NAME=` prefixes.
`TEAMS_APP_ID` must be the actual nonzero app GUID from provisioning, not a
new random GUID. The staging script replaces identity placeholders instead of
appending duplicate keys, and writes complete lines even when the template
has no trailing newline. Other environment settings are preserved.
If WIQD reports `PLUGIN_NOT_PROVISIONED` during packaging, check these stored
values and use the updated staging script; do not create another app or rerun
provisioning blindly to bypass the error.
Leave `create_new_app` unchecked on subsequent runs to reuse that identity.
Existing IDs must be absent when deliberately creating a separate new app.
Do not upload environment files, user-secret files or authentication caches.
The workflow serializes provisioning and never automatically retries it.
If a mutation fails before a receipt is written, inspect the dev app before
rerunning; do not assume nothing was created.

Download `banking-skills-plugin` for the verified ZIP and SHA-256 checksum.
When publication is enabled, `banking-skills-publication` contains the successful
submission receipt. Success means submitted for tenant administrator approval,
not approved, available tenant-wide, or published to the public Marketplace.
TDP package validation uploads the exported ZIP and may require separately
qualified authentication/service access. It does not evaluate skill behavior.
WIQD publish rebuilds its upload from the staged project; validating the exported
ZIP does not prove that publish uploads those exact same bytes.
No audience sharing or public Marketplace submission is performed. No live
release was executed by the assistant while implementing this pipeline; the
repository owner subsequently reported a successful update (see below).

Fresh GitHub-hosted runners cannot use this release path without an officially
supported consent setup. Do not add automated acceptance, fake receipts or copy
developer configuration/authentication caches into CI. If consent becomes
invalid, re-run the human setup on the dedicated runner; the pipeline fails
closed rather than repairing consent automatically.

## Reusable implementation record

On 10 November 2026, the repository owner confirmed that the latest change
reached the M365 Tools plugin through this pipeline. This is a user-reported
successful update, not evidence that every skill's runtime behavior was tested
or that another tenant's approval/authentication policies will be identical.

For future implementations, reuse these project-owned components:

- [Validation workflow](.github/workflows/validate-plugin.yml): secret-free PR
  checks, followed by trusted deployment of the same merged revision on `main`.
- [Packaging workflow](.github/workflows/package-plugin.yml): prepared runner,
  `dev` environment bindings, serialized releases, version reservation and receipts.
- [Lifecycle script](scripts/plugin.ps1): fresh staging, WIQD skill registration,
  publisher/identity injection, validation, packaging and organization submission.
- [Skill checker](scripts/skills.mjs): dynamic skill discovery and exact packaged
  resource verification, rather than a fixed expected number of skills.
- [Version allocator](scripts/release-version.mjs): durable, increasing versions
  across both successful and failed deployment attempts.
- [Regression tests](scripts/skills.test.mjs): runner prerequisites, release
  routing, version allocation, staged identity and lifecycle failure gates.

Lessons that made this deployment work:

1. Prepare and verify WIQD under the runner service account, not only an SSH
   login. Make its executable directory explicit through `WIQD_BIN_DIR`.
2. Keep human EULA acceptance outside automation. Store credentials as GitHub
   environment secrets and publisher details/app IDs as environment variables.
3. Separate one-time app creation from recurring submission. Reuse real app IDs;
   do not provision again merely because a packaging diagnostic suggests it.
4. Reserve a higher version before cloud operations. Keep failed reservations;
   use a confirmed version floor when onboarding an already-uploaded app.
5. Replace staged environment assignments instead of appending to templates.
   Missing final newlines and duplicate placeholders must not corrupt app IDs.
6. Test the environment file actually read by the packager, not just inherited
   process variables. Keep regression cases for missing newlines and duplicate IDs.
7. Stop on validation or lifecycle failures; never automatically retry uncertain
   cloud mutations. Submission and tenant administrator approval are separate.

When adapting this pattern to another repository, confirm its source directories,
CLI version, tenant, authentication policy and catalog destination first. Follow
the onboarding sections above; never copy credentials, consent state or app IDs
from this deployment.

## Local checks

Install Node.js 24.15.0 or newer, PowerShell 7 and WIQD 0.25.0, then:

```powershell
npm ci
npm test
npm run check
.\scripts\plugin.ps1 -ProjectPath (Join-Path $env:TEMP ("banking-skills-" + [guid]::NewGuid()))
```

The staging directory must not already exist. Local source checks do not
provision or publish resources.
