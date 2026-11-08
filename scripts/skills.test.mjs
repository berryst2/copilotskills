import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    } else {
      assert.equal(workflow.jobs.package.environment, 'dev');
      assert.equal(workflow.jobs.package.if, "github.ref == 'refs/heads/main'");
      assert.equal(workflow.concurrency['cancel-in-progress'], false);
    }
  }
});
