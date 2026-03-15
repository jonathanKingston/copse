# ADR 001: Zero External Runtime Dependencies

## Status

Accepted

## Context

copse is a CLI tool for managing agent-created PRs. When choosing how to manage
dependencies, we considered two approaches:

1. Pull in npm packages for HTTP servers, argument parsing, terminal UI, etc.
2. Rely solely on Node.js built-in modules and ship with zero external runtime
   dependencies.

Node.js (18+) now provides mature built-in modules for HTTP (`node:http`),
file-system access (`node:fs`), child-process execution (`node:child_process`),
path manipulation (`node:path`), and test running (`node:test`). These cover
every capability copse needs.

Third-party dependencies carry ongoing costs: version churn, supply-chain
security risk, installation time, and compatibility breakage. For a tool that
wraps an existing CLI (`gh`), a large dependency tree would add weight without
proportional value.

## Decision

copse has zero external runtime dependencies. The only `devDependencies` are
TypeScript and `@types/node`, which are used at build time and not shipped to
users.

All runtime functionality -- HTTP serving, JSON handling, process spawning,
file I/O, terminal interaction -- uses Node.js built-in APIs.

## Consequences

- **Faster installs.** `npm install -g @copse/cli` downloads only the copse
  package itself; there is no `node_modules` tree to resolve or fetch.
- **Reduced supply-chain risk.** No third-party code runs at runtime, removing
  an entire class of dependency-based vulnerabilities.
- **Smaller attack surface for audits.** Security reviewers only need to inspect
  copse's own code plus Node.js built-ins.
- **Higher implementation effort for some features.** Argument parsing, HTTP
  routing, and TUI rendering are hand-rolled rather than delegated to libraries
  like `yargs`, `express`, or `ink`. This means more code to maintain in-house.
- **Node.js version floor.** The tool requires Node.js 18+ to guarantee that
  the built-in APIs it depends on (e.g., `node:test`, fetch, structured clone)
  are available.
