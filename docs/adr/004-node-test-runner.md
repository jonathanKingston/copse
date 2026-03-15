# ADR 004: Use Node.js Built-in Test Runner

## Status

Accepted

## Context

copse needs a test runner for its test suite. The common choices in the Node.js
ecosystem include Jest, Vitest, Mocha, and the built-in `node:test` module
(stable since Node.js 18).

Given the project's zero-dependency philosophy (ADR 001), adding a test
framework would introduce the only external runtime or dev dependency beyond
TypeScript itself. The built-in `node:test` module provides `describe`, `it`,
`test`, `before`, `after`, hooks, subtests, and the `node:assert` module
provides assertion functions -- covering the functionality copse's tests need.

## Decision

copse uses the Node.js built-in test runner (`node --test`) to execute tests.
The test script in `package.json` is:

```
node --test "dist/tests/**/*.test.js"
```

Tests are written in TypeScript, compiled alongside the rest of the codebase
by `tsc`, and run from the `dist/` output directory. The `node:test` and
`node:assert` modules provide all necessary test infrastructure.

## Consequences

- **No test framework dependency.** The only `devDependencies` remain
  `typescript` and `@types/node`, keeping the project minimal.
- **Consistent with ADR 001.** Using built-in modules for testing reinforces
  the zero-dependency principle across both production and test code.
- **Tests run from compiled output.** Because `node --test` runs `.js` files,
  the build step (`tsc`) must complete before tests execute. The `pretest`
  script handles this automatically.
- **Fewer ecosystem integrations.** Some IDE plugins and CI tools have deeper
  integration with Jest or Vitest (e.g., inline coverage, watch mode). The
  built-in runner's tooling ecosystem is smaller, though sufficient for
  copse's needs.
- **Node.js 18+ required.** The `node:test` module is stable from Node.js 18
  onward, which aligns with the project's existing engine requirement.
