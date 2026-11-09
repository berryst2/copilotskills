import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { zipSync, strToU8 } from 'fflate';
import { parseDocument } from 'yaml';
import { discover, verify, repository } from './skills.mjs';

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
    } else {
      assert.equal(workflow.on.workflow_call.inputs.publish.type, 'boolean');
      assert.equal(workflow.on.workflow_dispatch.inputs.publish.default, false);
      assert.deepEqual(workflow.jobs.package['runs-on'], ['self-hosted', 'Linux', 'X64']);
      assert.equal(workflow.jobs.package.environment, 'dev');
      assert.equal(workflow.jobs.package.if, "github.ref == 'refs/heads/main'");
      assert.equal(workflow.concurrency['cancel-in-progress'], false);
      const steps = workflow.jobs.package.steps;
      const preflight = steps.findIndex(step => step.run === './scripts/check-wiqd.ps1');
      const deploy = steps.findIndex(step => step.env?.M365_ACCOUNT_PASSWORD);
      assert.ok(preflight >= 0 && preflight < deploy);
      assert.equal(steps[deploy].env.PUBLISH_PLUGIN, '${{ inputs.publish }}');
      assert.match(steps[deploy].run, /-Publish:/);
      const receipt = steps.find(step => step.with?.name === 'banking-skills-publication');
      assert.equal(receipt.if, 'success() && inputs.publish');
      assert.equal(steps.at(-1).if, 'always()');
    }
  }
});

test('runner preflight accepts existing consent and rejects missing consent without accepting', () => {
  const script = join(repository, 'scripts', 'check-wiqd.ps1').replaceAll("'", "''");
  for (const state of ['accepted', 'required']) {
    const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
      function wiqd {
        if ($args -contains 'accept') { throw 'Test must never perform acceptance.' }
        $global:LASTEXITCODE = 0
        if ($args -contains '--version') { return '0.24.0' }
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
    if (state === 'accepted') {
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
  for (const failure of ['', 'package-validation', 'publish']) {
    await t.test(failure || 'successful submission', t => {
      const root = fixture(t);
      for (const folder of ['scripts', 'banking-skills']) {
        cpSync(join(repository, folder), join(root, folder), { recursive: true });
      }
      for (const dependency of ['yaml', 'fflate']) {
        cpSync(join(repository, 'node_modules', dependency),
          join(root, 'node_modules', dependency), { recursive: true });
      }
      writeFileSync(join(root, 'package.json'), '{"private":true,"type":"module"}');
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
      delete env.M365_REFRESH_TOKEN;
      const result = spawnSync('pwsh', ['-NoProfile', '-NonInteractive', '-Command', `
        function wiqd {
          Add-Content -LiteralPath (Join-Path $env:TEST_ROOT 'commands.jsonl') -Value (ConvertTo-Json -InputObject @($args) -Compress)
          $global:LASTEXITCODE = 0
          if ($args -contains '--version') { return '0.24.0' }
          if ($args[0] -eq 'eula') { return '{"status":"success","data":{"wiqd":{"state":"accepted"}}}' }
          if (($env:TEST_FAILURE -eq 'package-validation' -and $args[1] -eq 'validate' -and $args -contains 'package') -or
              ($env:TEST_FAILURE -eq 'publish' -and $args[1] -eq 'publish')) {
            $global:LASTEXITCODE = 1
            return '{"status":"error","error":{"message":"Expected test failure"}}'
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
        & (Join-Path $env:TEST_ROOT 'scripts/plugin.ps1') -ProjectPath (Join-Path $env:TEST_ROOT 'staged') -Provision -Publish
      `], { encoding: 'utf8', env, timeout: 60000 });
      assert.ifError(result.error);
      const commands = readFileSync(join(root, 'commands.jsonl'), 'utf8')
        .trim().split(/\r?\n/).map(line => JSON.parse(line));
      const index = action => commands.findIndex(args => args[0] === 'plugin' && args[1] === action);
      const packageValidation = commands.findIndex(args =>
        args[1] === 'validate' && args.includes('package'));
      assert.ok(index('provision') > index('validate'));
      assert.ok(index('package') > index('provision'));
      assert.ok(packageValidation > index('package'));
      assert.ok(existsSync(join(root, 'dist', 'checksum.json')));
      const receipt = join(root, 'dist', 'publication-receipt.json');
      if (!failure) {
        assert.equal(result.status, 0, result.stderr);
        assert.ok(index('publish') > packageValidation);
        assert.equal(JSON.parse(readFileSync(receipt, 'utf8').replace(/^\uFEFF/, '')).status,
          'submitted_for_admin_approval');
      } else {
        assert.notEqual(result.status, 0);
        assert.equal(existsSync(receipt), false);
        if (failure === 'package-validation') assert.equal(index('publish'), -1);
      }
    });
  }
});
