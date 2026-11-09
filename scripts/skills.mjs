import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, join, relative, dirname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';
import { unzipSync } from 'fflate';

const categories = ['legal', 'lending', 'operations', 'technology'];
export const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function filesIn(folder) {
  const files = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    const path = join(folder, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symlinks are not allowed: ${path}`);
    if (entry.isDirectory()) files.push(...filesIn(path));
    else if (entry.isFile()) {
      if (/^\.env(?:\.|$)|\.(?:pem|key)$/i.test(entry.name)) {
        throw new Error(`Potential credential file must not be packaged: ${path}`);
      }
      files.push(path);
    } else throw new Error(`Unsupported file type: ${path}`);
  }
  return files.sort();
}

export function discover(root = repository) {
  const skills = [];
  const names = new Set();
  for (const category of categories) {
    const entries = readdirSync(join(root, category), { withFileTypes: true });
    let count = 0;
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entry.isSymbolicLink()) throw new Error(`Symlink in category ${category}`);
      if (!entry.isDirectory()) continue;
      const folder = join(root, category, entry.name);
      const files = filesIn(folder);
      const skillFile = join(folder, 'SKILL.md');
      if (!files.includes(skillFile)) throw new Error(`Missing SKILL.md: ${folder}`);
      const text = readFileSync(skillFile, 'utf8');
      const header = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
      if (!header) throw new Error(`Missing YAML frontmatter: ${skillFile}`);
      const document = parseDocument(header[1], { uniqueKeys: true });
      if (document.errors.length) throw new Error(`${skillFile}: ${document.errors[0].message}`);
      const metadata = document.toJS();
      if (!metadata || typeof metadata.name !== 'string'
          || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(metadata.name)
          || metadata.name.length > 64 || metadata.name !== entry.name) {
        throw new Error(`Skill name must match its kebab-case folder: ${skillFile}`);
      }
      if (typeof metadata.description !== 'string' || !metadata.description.trim()
          || metadata.description.length > 1024) {
        throw new Error(`Missing or invalid description: ${skillFile}`);
      }
      if (names.has(metadata.name)) throw new Error(`Duplicate skill name: ${metadata.name}`);
      names.add(metadata.name);
      if (!text.slice(header[0].length).trim()) throw new Error(`Empty skill body: ${skillFile}`);
      for (const match of text.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g)) {
        const target = match[1].replace(/^<|>$/g, '').split('#')[0];
        if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target)) continue;
        const resource = resolve(folder, decodeURIComponent(target));
        if (!resource.startsWith(`${folder}${sep}`) || !existsSync(resource)) {
          throw new Error(`Missing or escaping resource ${target}: ${skillFile}`);
        }
      }
      skills.push({
        name: metadata.name,
        description: metadata.description,
        folder,
        files: files.map(file => relative(folder, file).split(sep).join('/'))
      });
      count++;
    }
    if (!count) throw new Error(`No skills found in ${category}`);
  }
  return skills;
}

export function verify(zipPath, root = repository) {
  const skills = discover(root);
  const archive = unzipSync(readFileSync(zipPath));
  if (!archive['manifest.json']) throw new Error('ZIP has no manifest.json');
  const manifest = JSON.parse(Buffer.from(archive['manifest.json']).toString('utf8'));
  if (JSON.stringify(manifest).includes('${{')) throw new Error('ZIP has unresolved manifest variables');
  const folders = skills.map(skill => `skills/${skill.name}`);
  const actual = (manifest.agentSkills ?? []).map(skill => skill.folder).sort();
  if (JSON.stringify(actual) !== JSON.stringify([...folders].sort())) {
    throw new Error('ZIP manifest does not register exactly the source skills');
  }
  const expected = new Set(['manifest.json', manifest.icons.color, manifest.icons.outline]);
  for (const icon of [manifest.icons.color, manifest.icons.outline]) {
    if (!archive[icon]?.length) throw new Error(`Missing ZIP icon: ${icon}`);
  }
  for (const skill of skills) {
    for (const file of skill.files) {
      const member = `skills/${skill.name}/${file}`;
      expected.add(member);
      const source = readFileSync(join(skill.folder, ...file.split('/')));
      if (!archive[member] || !source.equals(Buffer.from(archive[member]))) {
        throw new Error(`ZIP resource missing or changed: ${member}`);
      }
    }
  }
  for (const member of Object.keys(archive)) {
    if (member.endsWith('/')) continue;
    if (!expected.has(member)) throw new Error(`Unexpected ZIP member: ${member}`);
  }
  return { skillCount: skills.length, fileCount: expected.size };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const command = process.argv[2];
    if (command === 'discover') console.log(JSON.stringify(discover(), null, 2));
    else if (command === 'verify' && process.argv[3]) console.log(JSON.stringify(verify(process.argv[3])));
    else throw new Error('Usage: node scripts/skills.mjs discover | verify <zip>');
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
