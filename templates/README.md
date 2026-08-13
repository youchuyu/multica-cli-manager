# {{PROJECT_NAME}}

Multica workspace declarations live under `src/workspaces/`. The directory is empty until the first pull. Structured declarations use JSON; Agent instructions and Skill files remain ordinary files.

```sh
multica setup
npm install
npm run workspace:pull -- <slug>
npm run workspace:diff -- <slug>
npm run workspace:push -- <slug>
npm run workspace:push -- <slug> --dry-run
```

Pull and push validate, execute, and reread their targets by default. `--dry-run` is preview-only. `--hard` resolves conflicts in the selected direction and cleans target-only resources (local pull removals go to `.multica/trash/`; hard push archives extra Agents and deletes extra Skills, Projects, and Skill files). Credentials stay in the Multica CLI profile.
