import { access, mkdir, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, join } from 'node:path';

async function assertEmpty(path) {
  try { await access(path, constants.F_OK); throw new Error(`target already exists: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function createProject(target, requestedName) {
  await assertEmpty(target);
  const name = basename(requestedName).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!name) throw new Error('a valid project name is required');
  await mkdir(join(target, 'src/workspace'), { recursive: true });
  await writeFile(join(target, 'src/workspace/.gitkeep'), '');
  await writeFile(join(target, '.gitignore'), 'node_modules/\n.env\n.DS_Store\n');
  await writeFile(join(target, 'package.json'), JSON.stringify({
    name, private: true, version: '0.1.0', type: 'module',
    scripts: {
      'workspace:pull': 'multica-cli-manager workspace pull',
      'workspace:diff': 'multica-cli-manager workspace diff',
      'workspace:push': 'multica-cli-manager workspace push'
    },
    devDependencies: { 'multica-cli-manager': '^0.1.0' }
  }, null, 2) + '\n');
  await writeFile(join(target, 'README.md'), `# ${name}\n\nMultica workspace snapshots live under \`src/workspace/\`. The directory is empty until the first pull.\n\n\`\`\`sh\nmultica setup\nnpm install\nnpm run workspace:pull -- --workspace <slug>\nnpm run workspace:diff -- --workspace <slug>\nnpm run workspace:push -- --workspace <slug> --apply\n\`\`\`\n`);
  console.log(`Created ${name} at ${target}`);
  console.log(`Next: cd ${name} && npm install`);
}
