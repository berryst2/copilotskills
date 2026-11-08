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
`main`, and can also be run manually. It uses Node 24.15.0 on GitHub-hosted
Ubuntu, runs the source/ZIP checker tests and checks all source folders.
It does not install/run WIQD, stage a plugin, or receive deployment credentials.
These are repository checks, not WIQD validation. WIQD source validation remains
a required release gate on the prepared runner.

WIQD source validation does not provide full skill-only plugin validation.
Repository checks cover source structure and local Markdown links; release
checks verify every packaged skill/resource byte and reject unexpected ZIP
files. Neither proves runtime behavior or Marketplace acceptance.

## Manual packaging

### Prepare a dedicated runner

The release workflow targets a persistent Linux x64 self-hosted runner with the
custom label `wiqd`. Install Node 24.15.0, PowerShell 7 and WIQD 0.24.0 during
human runner setup, and ensure `wiqd` is on the runner service account's PATH.

A human must review the [WIQD EULA](https://aka.ms/wiqd/eula) and, if they agree,
run `wiqd eula accept wiqd` interactively outside CI as that same account.
Confirm `wiqd eula status --json` reports `data.wiqd.state` as `accepted`.
Acceptance on your development machine does not establish acceptance on a
different runner account. CI never performs acceptance. The release job checks
the pinned version and existing acceptance before injecting credentials.

Keep this runner restricted to trusted release workflows on `main`; do not run
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

For the first deployment only, check `create_new_app`. This authorizes creation
of cloud resources in the shared `dev` environment. The scaffold's provision
lifecycle registers/updates the app and publishes a shared deployment; it is
not an offline ZIP build or tenant-catalog submission.

Download `banking-skills-provisioning-ids` and save its three non-secret values
as environment variables `TEAMS_APP_ID`, `M365_TITLE_ID` and `M365_APP_ID`.
Leave `create_new_app` unchecked on subsequent runs to reuse that identity.
Existing IDs must be absent when deliberately creating a separate new app.
Do not upload environment files, user-secret files or authentication caches.
The workflow serializes provisioning and never automatically retries it.
If a mutation fails before a receipt is written, inspect the dev app before
rerunning; do not assume nothing was created.

Download `banking-skills-plugin` for the verified ZIP and SHA-256 checksum.
The pipeline does not submit to the tenant catalog, share with an audience or
upload the ZIP for TDP/Marketplace validation. Run those as separately approved
operations. No release was executed while implementing this pipeline.

Fresh GitHub-hosted runners cannot use this release path without an officially
supported consent setup. Do not add automated acceptance, fake receipts or copy
developer configuration/authentication caches into CI. If consent becomes
invalid, re-run the human setup on the dedicated runner; the pipeline fails
closed rather than repairing consent automatically.

## Local checks

Install Node.js 24.15.0 or newer, PowerShell 7 and WIQD 0.24.0, then:

```powershell
npm ci
npm test
npm run check
.\scripts\plugin.ps1 -ProjectPath (Join-Path $env:TEMP ("banking-skills-" + [guid]::NewGuid()))
```

The staging directory must not already exist. Local source checks do not
provision or publish resources.
