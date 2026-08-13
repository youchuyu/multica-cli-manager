import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const templateDir = join(dirname(fileURLToPath(import.meta.url)), '../../templates');

const readTemplate = (name) => readFile(join(templateDir, name), 'utf8');

async function assertEmpty(path) {
  try { await access(path, constants.F_OK); throw new Error(`target already exists: ${path}`); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}

export async function createProject(target, requestedName) {
  await assertEmpty(target);
  const name = basename(requestedName).toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
  if (!name) throw new Error('a valid project name is required');
  const [readmeTemplate, agentsTemplate, gitignoreTemplate] = await Promise.all([
    readTemplate('README.md'),
    readTemplate('AGENTS.md'),
    readTemplate('gitignore')
  ]);
  await mkdir(join(target, 'src/workspaces'), { recursive: true });
  await writeFile(join(target, 'src/workspaces/.gitkeep'), '');
  await writeFile(join(target, '.gitignore'), gitignoreTemplate);
  await writeFile(join(target, 'package.json'), JSON.stringify({
    name, private: true, version: '0.1.0', type: 'module',
    scripts: {
      'workspace:pull': 'multica-cli-manager workspace pull',
      'workspace:diff': 'multica-cli-manager workspace diff',
      'workspace:push': 'multica-cli-manager workspace push'
    },
    devDependencies: { 'multica-cli-manager': '^0.1.0' }
  }, null, 2) + '\n');
  await writeFile(join(target, 'README.md'), readmeTemplate.replaceAll('{{PROJECT_NAME}}', name));
  await writeFile(join(target, 'AGENTS.md'), agentsTemplate);
  console.log(`Created ${name} at ${target}`);
  console.log(`Next: cd ${name} && npm install`);
}
