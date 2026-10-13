# {{PROJECT_NAME}}

Multica workspace declarations live under `src/workspaces/`. The directory is empty until the first pull. Structured declarations use JSON; Agent and Squad instructions plus Skill files remain ordinary files. Agent `custom-env.json` files contain exact remote values and are ignored by Git by default.

```sh
multica setup
npm install
npm run workspace:pull -- <slug>
npm run workspace:diff -- <slug>
npm run workspace:push -- <slug>
npm run workspace:push -- <slug> --dry-run
```

Pull and push validate, execute, and reread their targets by default. Agent runtime configuration, MCP configuration, custom CLI arguments, Skill assignments, custom environment variables, and Squad membership are synchronized exactly. `--dry-run` is preview-only and never prints environment values. `--hard` resolves conflicts in the selected direction and cleans target-only resources (local pull removals go to `.multica/trash/`; hard push archives extra Agents and Squads and deletes extra Skills, Projects, and Skill files). Squad member removals also require `--hard`.
