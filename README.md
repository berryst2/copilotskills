# Banking skills plugin

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
environment's approval gates, it runs WIQD source validation, provisions the
existing shared dev deployment, revalidates source, packages and verifies the
ZIP, validates that exact exported ZIP with Microsoft's TDP service, and runs
`wiqd plugin publish` to submit to the organization catalog for tenant
administrator approval. PRs never invoke deployment, and failed/skipped source
checks block it. The called workflow checks out the same triggering revision.

Automatic deployment requires the three existing app IDs below. It never
creates a new app automatically. Bootstrap once using the manual packaging
workflow, save the IDs, then subsequent successful main validations deploy
automatically. Updating these workflows does not itself execute a deployment.

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
required reviewers before enabling provisioning.

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

For the first deployment only, check `create_new_app`. This authorizes creation
of cloud resources in the shared `dev` environment. The scaffold's provision
lifecycle registers/updates the app and publishes a shared deployment; it is
not an offline ZIP build or tenant-catalog submission.
For manual runs, `publish` defaults to false (package only). Check it explicitly
to validate the exported ZIP with Microsoft and submit to the organization
catalog. Automatic deployment from the validation workflow sets `publish: true`.

Download `banking-skills-provisioning-ids` and save its three non-secret values
as environment variables `TEAMS_APP_ID`, `M365_TITLE_ID` and `M365_APP_ID`.
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
release was executed while implementing this pipeline.

Fresh GitHub-hosted runners cannot use this release path without an officially
supported consent setup. Do not add automated acceptance, fake receipts or copy
developer configuration/authentication caches into CI. If consent becomes
invalid, re-run the human setup on the dedicated runner; the pipeline fails
closed rather than repairing consent automatically.

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
