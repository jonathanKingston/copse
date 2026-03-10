# AGENTS.md

## Cursor Cloud specific instructions

**Copse** (`@copse/cli`) is a CLI tool and local web dashboard for managing AI-agent-created GitHub PRs. Zero runtime dependencies — only `typescript` and `@types/node` as devDependencies.

### Commands reference

Standard npm scripts are defined in `package.json`:

- **Build**: `npm run build` (runs `tsc` then copies `web/public` to `dist/web/public`)
- **Test**: `npm test` (builds first via `pretest`, then runs `node --test "dist/tests/**/*.test.js"`)
- **CLI**: `node dist/copse.js` (or `npm start`)
- **Web dashboard**: `node dist/copse.js web --host 0.0.0.0 --port 4317`

### Non-obvious notes

- The `pretest` hook runs `npm run build` automatically, so `npm test` always builds fresh before testing.
- All GitHub operations shell out to the `gh` CLI — the `gh` tool must be installed and authenticated for any command except `init` and `web` (the web UI gracefully shows an error banner when `gh` auth fails).
- The web server binds to `127.0.0.1` by default; use `--host 0.0.0.0` to make it accessible externally in cloud environments.
- There is no linter configured in this project (no ESLint, Prettier, etc.) — the TypeScript compiler in strict mode serves as the primary code quality check.
- The project uses ES modules (`"type": "module"` in `package.json`); all imports require `.js` extensions in the source TypeScript files.
