export const versionRecordPrefix = 'banking-skills-dev-version-';
export const versionTagPrefix = 'refs/tags/banking-skills/dev/v';

function parseVersion(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    throw new Error(`Invalid app version: ${value}. Use major.minor.patch.`);
  }
  const parts = value.split('.').map(Number);
  if (parts.some(part => part > 65535)) {
    throw new Error(`App version components must not exceed 65535: ${value}`);
  }
  return parts;
}

function compare(left, right) {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
}

export function nextReleaseVersion(sourceVersion, recordNames, versionFloor = '', createNewApp = false) {
  const versions = [parseVersion(sourceVersion)];
  let records = 0;
  for (const name of recordNames) {
    if (name.startsWith(versionTagPrefix)) {
      versions.push(parseVersion(name.slice(versionTagPrefix.length)));
      records++;
      continue;
    }
    if (!name.startsWith(versionRecordPrefix)) continue;
    const match = name.slice(versionRecordPrefix.length).match(/^(\d+\.\d+\.\d+)-\d+-\d+$/);
    if (!match) throw new Error(`Invalid version reservation artifact: ${name}`);
    versions.push(parseVersion(match[1]));
    records++;
  }
  if (versionFloor) versions.push(parseVersion(versionFloor));
  if (records === 0 && !createNewApp && !versionFloor) {
    throw new Error('No shared version record exists. Configure the dev environment variable PLUGIN_VERSION_FLOOR once with the highest version already uploaded to Microsoft (or supply the manual version_floor input). Do not guess or create another app.');
  }
  const next = versions.reduce((highest, version) => compare(version, highest) > 0 ? version : highest).slice();
  for (let index = 2; index >= 0; index--) {
    if (next[index] < 65535) {
      next[index]++;
      return next.join('.');
    }
    next[index] = 0;
  }
  throw new Error('App version range exhausted; no higher supported version remains.');
}
