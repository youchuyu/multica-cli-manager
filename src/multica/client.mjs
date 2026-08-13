import { spawn } from 'node:child_process';

export function runMultica(command, { profile, workspaceId, input, json = true } = {}) {
  const args = [...command, ...(profile ? ['--profile', profile] : []), ...(workspaceId ? ['--workspace-id', workspaceId] : []), ...(json ? ['--output', 'json'] : [])];
  return new Promise((resolve, reject) => {
    const child = spawn('multica', args);
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code !== 0) return reject(new Error(stderr.trim() || `multica exited with ${code}`));
      if (!json) return resolve({ stdout, stderr });
      try { resolve(JSON.parse(stdout || 'null')); } catch { reject(new Error(`Invalid JSON from multica: ${stdout.slice(0, 200)}`)); }
    });
    child.stdin.end(input ?? '');
  });
}

export const listItems = (value) => Array.isArray(value) ? value : value?.items ?? value?.data ?? [];
