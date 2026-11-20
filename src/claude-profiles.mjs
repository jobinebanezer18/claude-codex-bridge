import { randomUUID } from 'node:crypto';
import { lstatSync, mkdirSync, readFileSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

const activeProfile = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
const profileFile = (directory) => join(directory, 'claude-profiles.json');

function savedProfiles(directory) {
  const file = profileFile(directory);
  try {
    const info = lstatSync(file);
    if (!info.isFile() || info.uid !== process.getuid() || (info.mode & 0o077)) {
      throw new Error('Claude profile configuration must be a private local file.');
    }
    const paths = JSON.parse(readFileSync(file, 'utf8'));
    if (!Array.isArray(paths) || paths.some((value) => typeof value !== 'string' || !isAbsolute(value))) {
      throw new Error('Claude profile configuration contains an invalid path.');
    }
    return paths;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

export function claudeRegistries(directory) {
  const paths = directory ? savedProfiles(directory) : [];
  return [...new Set([activeProfile(), ...paths].map((path) => join(path, 'sessions')))];
}

export function addClaudeProfile(directory, path) {
  const profile = realpathSync(path);
  if (!statSync(join(profile, 'sessions')).isDirectory()) throw new Error('Choose a Claude configuration directory with a sessions folder.');
  const profiles = [...new Set([...savedProfiles(directory), realpathSync(activeProfile()), profile])];
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temp = join(directory, `.claude-profiles-${randomUUID()}.json`);
  writeFileSync(temp, JSON.stringify(profiles, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  try { renameSync(temp, profileFile(directory)); }
  finally {
    try { unlinkSync(temp); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { profile, registeredProfiles: profiles.length };
}
