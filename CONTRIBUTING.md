# Contributing to copse

## Development setup

```bash
git clone https://github.com/jonathanKingston/copse.git
cd copse
npm install
npm run build
```

Requires Node.js 18+ and the [GitHub CLI](https://cli.github.com/) (`gh`) installed and authenticated.

## Project structure

```
copse.ts          # Entry point — CLI router, command definitions
commands/         # One file per command (approval.ts, create-prs.ts, etc.)
lib/              # Shared utilities (gh wrapper, arg parsing, types, filters, config)
lib/services/     # Service modules used by commands
web/              # Web UI (copse web) — server + static assets in web/public/
tests/            # Tests (Node.js built-in test runner)
```

TypeScript compiles to `dist/` via `tsc`. The `dist/` directory mirrors the source layout.

## Running locally

```bash
npm run build          # Compile TypeScript
npm start              # Run the CLI (equivalent to: node dist/copse.js)
npm start -- web       # Run a specific command
```

During development, rebuild before each run. For the web UI there is a convenience script:

```bash
npm run web:dev        # Build + launch web UI with --open
```

## Running tests

```bash
npm test               # Builds first (via pretest), then runs tests
```

Tests use the Node.js built-in test runner (`node --test`). Test files live in `tests/` and follow the `*.test.ts` naming convention.

## Code style

- **TypeScript strict mode** — `strict: true` in `tsconfig.json` (ES2022 target, NodeNext modules).
- **Zero external runtime dependencies** — only `devDependencies` for TypeScript and type definitions. Everything uses Node.js built-in modules and the `gh` CLI.
- **ES modules** — the project uses `"type": "module"`. Use `.js` extensions in import paths (they resolve to compiled output in `dist/`).
- Keep files focused and small. Shared logic goes in `lib/`.

## Adding a new command

1. Create `commands/<command-name>.ts`. Export a default `async function` that receives parsed args. Look at an existing command like `commands/approval.ts` for the pattern.
2. Register the command in `copse.ts` by adding an entry to the `COMMANDS` record with its `file`, `description`, `usage`, and `args`.
3. Add tests in `tests/<command-name>.test.ts` if applicable.
4. Document the command in `README.md`.

## Pull request process

- PRs target the `main` branch.
- CI runs on Node.js 20 and 22. It performs a type check (`tsc --noEmit`), a full build, and verifies the CLI runs (`--help` for each command).
- Make sure `npm run build` and `npm test` pass locally before pushing.
- Keep the zero-dependency policy — do not add runtime dependencies.
