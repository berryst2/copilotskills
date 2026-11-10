import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { zipSync, unzipSync, strToU8 } from 'fflate';
import { parseDocument } from 'yaml';
import { discover, verify, repository } from './skills.mjs';
import { nextReleaseVersion, versionRecordPrefix } from './release-version.mjs';

test('release versions advance across workflows, failed attempts, and reruns', () => {
  const record = (version, run = 1, attempt = 1) => `${versionRecordPrefix}${version}-${run}-${attempt}`;
  assert.throws(() => nextReleaseVersion('1.0.0', []), /highest version already uploaded/);
  assert.equal(nextReleaseVersion('1.0.0', [], '', true), '1.0.1');
  assert.equal(nextReleaseVersion('1.0.0', [], '1.4.9'), '1.4.10');
  assert.equal(nextReleaseVersion('1.0.0',
    [record('1.4.10', 100), record('1.4.9', 90), 'unrelated']), '1.4.11');
  assert.equal(nextReleaseVersion('1.0.0',
    [record('1.4.10', 100), record('1.4.11', 100, 2)]), '1.4.12');
  assert.equal(nextReleaseVersion('2.0.0', [record('1.4.11')]), '2.0.1');
  assert.equal(nextReleaseVersion('1.0.0', [record('1.0.65535')]), '1.1.0');
  assert.equal(nextReleaseVersion('1.0.0', [record('1.65535.65535')]), '2.0.0');
  assert.throws(() => nextReleaseVersion('65535.65535.65535', [], '', true), /exhausted/);
  for (const value of ['1.0', '01.0.0', '1.0.0-beta', '1.0.65536', '1.0.0\n']) {
    assert.throws(() => nextReleaseVersion(value, [], '', true), /version/);
  }
  assert.throws(() => nextReleaseVersion('1.0.0', [record('1.0.65536')]), /65535/);
  assert.throws(() => nextReleaseVersion('1.0.0', [`${versionRecordPrefix}broken`]), /Invalid/);
});

test('workflow allocation trusts only main release runs and persists its selected version', async t => {
  const root = fixture(t);
  const workflow = parseDocument(readFileSync(
    join(repository, '.github', 'workflows', 'package-plugin.yml'), 'utf8')).toJS();
  const step = workflow.jobs.package.steps.find(step => step.id === 'version');
  const script = new (Object.getPrototypeOf(async function () {}).constructor)(
    'require', 'github', 'context', 'core', 'process', step.with.script);
  const artifacts = [
    { name: `${versionRecordPrefix}1.0.5-1-1`, workflow_run: { id: 1 } },
    { name: `${versionRecordPrefix}1.0.6-2-1`, workflow_run: { id: 2 } },
    { name: `${versionRecordPrefix}9.0.0-3-1`, workflow_run: { id: 3 } },
    { name: `${versionRecordPrefix}9.0.0-4-1`, workflow_run: { id: 4 } },
    { name: `${versionRecordPrefix}9.0.0-5-1`, workflow_run: { id: 5 } },
    { name: `${versionRecordPrefix}9.0.0-6-1`, workflow_run: { id: 6 }, expired: true }
  ];
  const github = {
    paginate: async () => artifacts,
    rest: { actions: {
      listArtifactsForRepo() {},
      getWorkflowRun: async ({ run_id }) => ({ data: {
        head_branch: 'main',
        head_repository: { full_name: 'owner/repo' },
        event: run_id === 3 ? 'pull_request' : 'workflow_dispatch',
        path: run_id === 4 ? '.github/workflows/untrusted.yml' :
          '.github/workflows/validate-plugin.yml',
        ...(run_id === 5 ? { head_repository: { full_name: 'fork/repo' } } : {})
      } })
    } }
  };
  const outputs = {};
  const env = {
    GITHUB_WORKSPACE: repository, RUNNER_TEMP: root, GITHUB_RUN_ATTEMPT: '2',
    VERSION_FLOOR: '', CREATE_NEW_APP: 'false'
  };
  await script(createRequire(import.meta.url), github,
    { repo: { owner: 'owner', repo: 'repo' }, runId: 7, sha: 'test-commit' },
    { setOutput: (key, value) => { outputs[key] = value; }, info() {} }, { env });
  assert.equal(outputs.version, '1.0.7');
  assert.deepEqual(JSON.parse(readFileSync(outputs.receipt, 'utf8')), {
    version: '1.0.7', runId: 7, attempt: '2', commit: 'test-commit', environment: 'dev'
  });
  artifacts.length = 0;
  await assert.rejects(() => script(createRequire(import.meta.url), github,
    { repo: { owner: 'owner', repo: 'repo' }, runId: 7 },
    { setOutput() {}, info() {} }, { env }), /No shared version record/);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'banking-skills-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const category of ['legal', 'lending', 'operations', 'technology']) {
    const folder = join(root, category, `${category}-test`);
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'SKILL.md'),
      `---\nname: ${category}-test\ndescription: Test skill\n---\n# Skill\n`);
  }
  return root;
}

function archive(root) {
  const skills = discover(root);
  const entries = {
    'manifest.json': strToU8(JSON.stringify({
      id: '01234567-89ab-4cde-8f01-23456789abcd',
      icons: { color: 'color.png', outline: 'outline.png' },
      agentSkills: skills.map(skill => ({ folder: `skills/${skill.name}` }))
    })),
    'color.png': new Uint8Array([1]),
    'outline.png': new Uint8Array([2])
  };
  for (const skill of skills) {
    for (const file of skill.files) {
      entries[`skills/${skill.name}/${file}`] = readFileSync(join(skill.folder, file));
    }
  }
  return entries;
}

test('repository contains 12 uniquely named skills', () => {
  assert.equal(discover().length, 12);
});

test('rejects malformed or duplicate YAML', t => {
  const root = fixture(t);
  writeFileSync(join(root, 'legal', 'legal-test', 'SKILL.md'),
    '---\nname: legal-test\nname: duplicate\ndescription: test\n---\nBody');
  assert.throws(() => discover(root), /unique|Map keys/i);
});

test('rejects duplicate skill names across categories', t => {
  const root = fixture(t);
  const folder = join(root, 'lending', 'legal-test');
  mkdirSync(folder);
  writeFileSync(join(folder, 'SKILL.md'),
    '---\nname: legal-test\ndescription: test\n---\nBody');
  assert.throws(() => discover(root), /Duplicate skill name/);
});

test('rejects missing resources and accepts complete supporting files', t => {
  const root = fixture(t);
  const folder = join(root, 'legal', 'legal-test');
  writeFileSync(join(folder, 'SKILL.md'),
    '---\nname: legal-test\ndescription: test\n---\n[Guide](guide.md)');
  assert.throws(() => discover(root), /Missing or escaping resource/);
  writeFileSync(join(folder, 'guide.md'), 'Guide');
  assert.equal(discover(root)[0].files.length, 2);
});

test('verifies exact ZIP content and rejects changed or extra files', t => {
  const root = fixture(t);
  const entries = archive(root);
  const zip = join(root, 'plugin.zip');
  writeFileSync(zip, zipSync(entries));
  assert.equal(verify(zip, root).skillCount, 4);
  entries['secrets.txt'] = strToU8('not allowed');
  writeFileSync(zip, zipSync(entries));
  assert.throws(() => verify(zip, root), /Unexpected ZIP member/);
  delete entries['secrets.txt'];
  entries['skills/legal-test/SKILL.md'] = strToU8('changed');
  writeFileSync(zip, zipSync(entries));
  assert.throws(() => verify(zip, root), /missing or changed/);
});

test('rejects unresolved variables and omitted skill registrations', t => {
  const root = fixture(t);
  const entries = archive(root);
  const zip = join(root, 'plugin.zip');
  const manifest = JSON.parse(Buffer.from(entries['manifest.json']).toString());
  manifest.id = '${{TEAMS_APP_ID}}';
  entries['manifest.json'] = strToU8(JSON.stringify(manifest));
  writeFileSync(zip, zipSync(entries));
  assert.throws(() => verify(zip, root), /unresolved/);
  manifest.id = '01234567-89ab-4cde-8f01-23456789abcd';
  manifest.agentSkills.pop();
  entries['manifest.json'] = strToU8(JSON.stringify(manifest));
  writeFileSync(zip, zipSync(entries));
  assert.throws(() => verify(zip, root), /exactly the source skills/);
});

test('workflow YAML parses with expected secret-free CI and gated release', () => {
  for (const file of ['validate-plugin.yml', 'package-plugin.yml']) {
    const document = parseDocument(readFileSync(join(repository, '.github', 'workflows', file), 'utf8'));
    assert.deepEqual(document.errors, []);
    const workflow = document.toJS();
    assert.ok(workflow.on.workflow_dispatch !== undefined || 'workflow_dispatch' in workflow.on);
    assert.equal(workflow.permissions.contents, 'read');
    const steps = (workflow.jobs.validate ?? workflow.jobs.package).steps;
    const powershell = steps.findIndex(step => step.name === 'Verify PowerShell prerequisite');
    const tests = steps.findIndex(step => step.run === 'npm test');
    const firstPowerShellStep = steps.findIndex(step => step.shell === 'pwsh');
    assert.ok(powershell >= 0 && powershell < tests);
    assert.equal(steps[powershell].shell, 'bash');
    assert.match(steps[powershell].run, /command -v pwsh/);
    assert.match(steps[powershell].run, /exit 1/);
    assert.match(steps[powershell].run, /PSVersion\.Major -lt 7/);
    if (firstPowerShellStep >= 0) assert.ok(powershell < firstPowerShellStep);
    if (file === 'validate-plugin.yml') {
      assert.ok(!JSON.stringify(workflow).includes('secrets.'));
      assert.ok(workflow.on.pull_request.paths.includes('legal/**'));
      assert.equal(workflow.jobs.validate.if,
        "github.event_name == 'pull_request' || github.ref == 'refs/heads/main'");
      const routing = workflow.jobs.validate['runs-on'].match(
        /^\$\{\{ fromJSON\(github\.event_name == 'pull_request' && '([^']+)' \|\| '([^']+)'\) \}\}$/);
      assert.ok(routing, 'Runner selection must keep PRs hosted and trusted jobs self-hosted');
      assert.deepEqual(JSON.parse(routing[1]), ['ubuntu-latest']);
      assert.deepEqual(JSON.parse(routing[2]), ['self-hosted', 'Linux', 'X64']);
      assert.ok(!workflow.jobs.validate.steps.some(step => /wiqd|plugin\.ps1/.test(step.run ?? '')));
      assert.equal(workflow.jobs.deploy.needs, 'validate');
      assert.equal(workflow.jobs.deploy.if,
        "github.ref == 'refs/heads/main' && (github.event_name == 'push' || github.event_name == 'workflow_dispatch')");
      assert.equal(workflow.jobs.deploy.uses, './.github/workflows/package-plugin.yml');
      assert.deepEqual(workflow.jobs.deploy.with, { create_new_app: false, publish: true });
      assert.equal(workflow.jobs.deploy.secrets, 'inherit');
      assert.equal(workflow.jobs.deploy.permissions.actions, 'read');
    } else {
      assert.equal(workflow.on.workflow_call.inputs.publish.type, 'boolean');
      assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
      assert.deepEqual(workflow.jobs.package['runs-on'], ['self-hosted', 'Linux', 'X64']);
      assert.equal(workflow.jobs.package.environment, 'dev');
      assert.equal(workflow.jobs.package.if, "github.ref == 'refs/heads/main'");
      assert.equal(workflow.concurrency['cancel-in-progress'], false);
      const steps = workflow.jobs.package.steps;
      const preflight = steps.findIndex(step => step.run === './scripts/check-wiqd.ps1');
      const executablePath = steps.findIndex(step => step.name === 'Configure WIQD executable directory');
      assert.ok(executablePath >= 0 && executablePath < preflight);
      assert.equal(steps[executablePath].env.WIQD_BIN_DIR, '${{ vars.WIQD_BIN_DIR }}');
      assert.match(steps[executablePath].run, /Add-Content -LiteralPath \$env:GITHUB_PATH/);
      const deploy = steps.findIndex(step => step.env?.M365_ACCOUNT_PASSWORD);
      const allocate = steps.findIndex(step => step.id === 'version');
      const reserve = steps.findIndex(step => step.name === 'Persist version reservation before cloud changes');
      assert.ok(tests < allocate && allocate < reserve && reserve < deploy);
      assert.equal(workflow.permissions.actions, 'read');
      assert.equal(steps[reserve].uses, 'actions/upload-artifact@v4');
      assert.equal(steps[reserve].with['if-no-files-found'], 'error');
      assert.equal(steps[deploy].env.RELEASE_VERSION, '${{ steps.version.outputs.version }}');
      assert.match(steps[deploy].run, /-ReleaseVersion \$env:RELEASE_VERSION/);
      assert.ok(preflight >= 0 && preflight < deploy);
      assert.equal(steps[deploy].env.PUBLISH_PLUGIN, '${{ inputs.publish }}');
      assert.match(steps[deploy].run, /-Publish:/);
      const receipt = steps.find(step => step.with?.name === 'banking-skills-publication');
      assert.equal(receipt.if, 'success() && inputs.publish');
      assert.equal(steps.at(-1).if, 'always()');
    }
  }
});

test('configured WIQD directory is persisted and invalid directories fail', t => {
  const root = fixture(t);
  const bin = join(root, 'bin with spaces');
  mkdirSync(bin);
  writeFileSync(join(bin, 'wiqd'), '');
  const workflow = parseDocument(readFileSync(
    join(repository, '.github', 'workflows', 'package-plugin.yml'), 'utf8')).toJS();
  const step = workflow.jobs.package.steps.find(step =>
    step.name === 'Configure WIQD executable directory');
  for (const [index, directory] of [bin, join(root, 'missing'), 'relative', `${bin}\nextra`].entries()) {
    const pathFile = join(root, `github-path-${index}`);
    writeFileSync(pathFile, '');
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', step.run], {
      encoding: 'utf8',
      env: { ...process.env, WIQD_BIN_DIR: directory, GITHUB_PATH: pathFile }
    });
    assert.ifError(result.error);
    if (index === 0) {
      assert.equal(result.status, 0, result.stderr);
      assert.equal(readFileSync(pathFile, 'utf8').trim(), bin);
    } else {
      assert.notEqual(result.status, 0);
      assert.match(result.stderr, /WIQD_BIN_DIR must be an absolute directory/);
      assert.equal(readFileSync(pathFile, 'utf8'), '');
    }
  }
});

test('runner preflight enforces the pinned version and existing consent without accepting', () => {
  const script = join(repository, 'scripts', 'check-wiqd.ps1').replaceAll("'", "''");
  for (const [version, state] of [
    ['0.25.0', 'accepted'],
    ['0.25.0', 'required'],
    ['0.24.0', 'accepted'],
    ['0.26.0', 'accepted']
  ]) {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
      function wiqd {
        if ($args -contains 'accept') { throw 'Test must never perform acceptance.' }
        $global:LASTEXITCODE = 0
        if ($args -contains '--version') { return '${version}' }
        if ('${version}' -ne '0.25.0') { throw 'Version mismatch must stop before checking consent.' }
        return '{"status":"success","data":{"wiqd":{"state":"${state}"}}}'
      }
      try {
        & '${script}'
      } catch {
        @{ message = $_.Exception.Message } | ConvertTo-Json -Compress
        exit 1
      }
    `], { encoding: 'utf8' });
    assert.ifError(result.error);
    if (version !== '0.25.0') {
      assert.equal(result.status, 1, result.stderr);
      const error = JSON.parse(result.stdout);
      assert.match(error.message, /must have WIQD 0\.25\.0/);
      assert.ok(error.message.includes(`version probe returned '${version}'`));
    } else if (state === 'accepted') {
      assert.equal(result.status, 0, result.stderr);
    } else {
      assert.equal(result.status, 1, result.stderr);
      const error = JSON.parse(result.stdout);
      assert.match(error.message, /human must review and accept/i);
      assert.match(error.message, /https:\/\/aka\.ms\/wiqd\/eula/);
      assert.match(error.message, /CI cannot accept/);
    }
  }
});

test('publication follows verified packaging and stops on validation or publish failures', async t => {
  for (const [label, failure, bootstrap, publish] of [
    ['existing app submission', '', false, true],
    ['package-validation', 'package-validation', false, true],
    ['publish', 'publish', false, true],
    ['first-time provisioning', '', true, false],
    ['first-time provisioning and submission', '', true, true],
    ['provision failure', 'provision', true, true]
  ]) {
    await t.test(label, t => {
      const root = fixture(t);
      for (const folder of ['scripts', 'banking-skills']) {
        cpSync(join(repository, folder), join(root, folder), { recursive: true });
      }
      for (const dependency of ['yaml', 'fflate']) {
        cpSync(join(repository, 'node_modules', dependency),
          join(root, 'node_modules', dependency), { recursive: true });
      }
      writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
      mkdirSync(join(root, 'dist'));
      for (const name of ['provisioning-ids.json', 'banking-skills.zip', 'checksum.json', 'publication-receipt.json']) {
        writeFileSync(join(root, 'dist', name), 'stale output from previous run');
      }
      writeFileSync(join(root, 'pack.mjs'), `
        import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
        import { join, relative, sep } from 'node:path';
        import { zipSync, strToU8 } from 'fflate';
        const [project, output] = process.argv.slice(2);
        const folder = join(project, 'appPackage');
        const manifest = JSON.parse(readFileSync(join(folder, 'manifest.json'), 'utf8'));
        manifest.id = process.env.TEAMS_APP_ID;
        manifest.name.short = 'banking-skillsdev';
        const entries = { 'manifest.json': strToU8(JSON.stringify(manifest)) };
        function visit(path) {
          for (const entry of readdirSync(path, { withFileTypes: true })) {
            const file = join(path, entry.name);
            if (entry.isDirectory()) visit(file);
            else if (entry.name !== 'manifest.json') {
              entries[relative(folder, file).split(sep).join('/')] = readFileSync(file);
            }
          }
        }
        visit(folder);
        writeFileSync(output, zipSync(entries));
      `);
      const env = {
        ...process.env,
        TEST_ROOT: root,
        TEST_FAILURE: failure,
        TEST_BOOTSTRAP: String(bootstrap),
        TEST_PUBLISH: String(publish),
        CI_ENABLED: 'true',
        M365_ACCOUNT_NAME: 'test-account',
        M365_ACCOUNT_PASSWORD: 'test-fixture-not-a-credential',
        PLUGIN_DEVELOPER_NAME: 'Test publisher',
        PLUGIN_WEBSITE_URL: 'https://bank.example',
        PLUGIN_PRIVACY_URL: 'https://bank.example/privacy',
        PLUGIN_TERMS_URL: 'https://bank.example/terms',
        TEAMS_APP_ID: '01234567-89ab-4cde-8f01-23456789abcd',
        M365_TITLE_ID: 'test-title',
        M365_APP_ID: 'test-app'
      };
      if (bootstrap) {
        delete env.TEAMS_APP_ID;
        delete env.M365_TITLE_ID;
        delete env.M365_APP_ID;
      }
      delete env.M365_REFRESH_TOKEN;
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
        function wiqd {
          Add-Content -LiteralPath (Join-Path $env:TEST_ROOT 'commands.jsonl') -Value (ConvertTo-Json -InputObject @($args) -Compress)
          $global:LASTEXITCODE = 0
          if ($args -contains '--version') { return '0.25.0' }
          if ($args[0] -eq 'eula') { return '{"status":"success","data":{"wiqd":{"state":"accepted"}}}' }
          if (($env:TEST_FAILURE -eq 'package-validation' -and $args[1] -eq 'validate' -and $args -contains 'package') -or
              ($env:TEST_FAILURE -eq 'publish' -and $args[1] -eq 'publish')) {
            $global:LASTEXITCODE = 1
            return '{"status":"error","error":{"message":"Expected test failure"}}'
          }
          if ($args[1] -eq 'provision') {
            if ($env:TEST_FAILURE -eq 'provision') {
              $global:LASTEXITCODE = 1
              return '{"status":"error","error":{"message":"Expected provision failure"}}'
            }
            $project = $args[[Array]::IndexOf($args, '--path') + 1]
            $env:TEAMS_APP_ID = '01234567-89ab-4cde-8f01-23456789abcd'
            Add-Content -LiteralPath (Join-Path $project 'env/.env.dev') -Value @(
              "TEAMS_APP_ID=$env:TEAMS_APP_ID", 'M365_TITLE_ID=test-title', 'M365_APP_ID=test-app')
          }
          if ($args[1] -eq 'add') {
            $project = $args[[Array]::IndexOf($args, '--folder') + 1]
            $name = $args[[Array]::IndexOf($args, '--name') + 1]
            $file = Join-Path $project 'appPackage/manifest.json'
            $manifest = Get-Content -LiteralPath $file -Raw | ConvertFrom-Json
            if (-not $manifest.PSObject.Properties['agentSkills']) {
              $manifest | Add-Member -NotePropertyName agentSkills -NotePropertyValue @()
            }
            $manifest.agentSkills += @{ folder = "skills/$name" }
            $manifest | ConvertTo-Json -Depth 100 | Set-Content -LiteralPath $file
          }
          if ($args[1] -eq 'package') {
            $project = $args[[Array]::IndexOf($args, '--path') + 1]
            $output = $args[[Array]::IndexOf($args, '--output') + 1]
            & node (Join-Path $env:TEST_ROOT 'pack.mjs') $project $output
            if ($LASTEXITCODE -ne 0) { throw 'Fixture ZIP creation failed.' }
          }
          return '{"status":"success","correlationId":"test-correlation"}'
        }
        & (Join-Path $env:TEST_ROOT 'scripts/plugin.ps1') -ProjectPath (Join-Path $env:TEST_ROOT 'staged') -Provision -ReleaseVersion '1.4.10' -CreateNewApp:($env:TEST_BOOTSTRAP -eq 'true') -Publish:($env:TEST_PUBLISH -eq 'true')
      `], { encoding: 'utf8', env, timeout: 60000 });
      assert.ifError(result.error);
      const commands = readFileSync(join(root, 'commands.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(line => JSON.parse(line));
      const index = action => commands.findIndex(args => args[0] === 'plugin' && args[1] === action);
      const packageValidation = commands.findIndex(args =>
        args[1] === 'validate' && args.includes('package'));
      if (bootstrap) assert.ok(index('provision') > index('validate'));
      else assert.equal(index('provision'), -1);
      const stagedManifest = JSON.parse(readFileSync(join(root, 'staged', 'appPackage', 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
      assert.equal(stagedManifest.version, '1.4.10');
      assert.equal(JSON.parse(readFileSync(join(root, 'banking-skills', 'appPackage', 'manifest.json'), 'utf8')).version,
        JSON.parse(readFileSync(join(repository, 'banking-skills', 'appPackage', 'manifest.json'), 'utf8')).version);
      const receipt = join(root, 'dist', 'publication-receipt.json');
      if (failure === 'provision') {
        assert.notEqual(result.status, 0);
        assert.equal(index('package'), -1);
        assert.equal(index('publish'), -1);
        assert.equal(existsSync(receipt), false);
        assert.equal(existsSync(join(root, 'dist', 'provisioning-ids.json')), false);
        assert.equal(existsSync(join(root, 'dist', 'banking-skills.zip')), false);
        return;
      }
      const packagedManifest = JSON.parse(new TextDecoder().decode(
        unzipSync(readFileSync(join(root, 'dist', 'banking-skills.zip')))['manifest.json']));
      assert.equal(packagedManifest.version, '1.4.10');
      assert.ok(index('package') > index('validate'));
      if (bootstrap) assert.ok(index('package') > index('provision'));
      if (!publish) {
        assert.equal(result.status, 0, result.stderr);
        assert.equal(packageValidation, -1);
        assert.equal(index('publish'), -1);
        assert.equal(existsSync(receipt), false);
        return;
      }
      assert.ok(packageValidation > index('package'));
      assert.ok(existsSync(join(root, 'dist', 'checksum.json')));
      if (!failure) {
        assert.equal(result.status, 0, result.stderr);
        assert.ok(index('publish') > packageValidation);
        assert.equal(JSON.parse(readFileSync(receipt, 'utf8').replace(/^\uFEFF/, '')).status,
          'submitted_for_admin_approval');
        assert.equal(JSON.parse(readFileSync(receipt, 'utf8').replace(/^\uFEFF/, '')).version, '1.4.10');
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(receipt), false);
        if (failure === 'package-validation') assert.equal(index('publish'), -1);
      }
    });
  }
});
