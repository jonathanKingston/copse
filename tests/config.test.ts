import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { loadConfig, loadEnvConfig, getConfiguredRepos } from "../lib/config.js";

function withEnv(vars: Record<string, string | undefined>, fn: () => void) {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(vars)) {
    saved[key] = process.env[key];
    if (vars[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = vars[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

function makeTempDir(): string {
  const dir = join(tmpdir(), `copse-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

test("loadEnvConfig returns repos from COPSE_REPOS", () => {
  withEnv(
    {
      COPSE_REPOS: "owner/repo1,owner/repo2",
      COPSE_CURSOR_API_KEY: undefined,
      COPSE_COMMENT_TEMPLATES: undefined,
    },
    () => {
      const config = loadEnvConfig();
      assert.deepEqual(config.repos, ["owner/repo1", "owner/repo2"]);
      assert.equal(config.cursorApiKey, undefined);
      assert.equal(config.commentTemplates, undefined);
    }
  );
});

test("loadEnvConfig trims whitespace and filters empty entries from COPSE_REPOS", () => {
  withEnv(
    {
      COPSE_REPOS: " owner/repo1 , owner/repo2 , ",
      COPSE_CURSOR_API_KEY: undefined,
      COPSE_COMMENT_TEMPLATES: undefined,
    },
    () => {
      const config = loadEnvConfig();
      assert.deepEqual(config.repos, ["owner/repo1", "owner/repo2"]);
    }
  );
});

test("loadEnvConfig returns cursorApiKey from COPSE_CURSOR_API_KEY", () => {
  withEnv(
    {
      COPSE_REPOS: undefined,
      COPSE_CURSOR_API_KEY: "my-secret-key",
      COPSE_COMMENT_TEMPLATES: undefined,
    },
    () => {
      const config = loadEnvConfig();
      assert.equal(config.cursorApiKey, "my-secret-key");
    }
  );
});

test("loadEnvConfig returns commentTemplates from COPSE_COMMENT_TEMPLATES", () => {
  withEnv(
    {
      COPSE_REPOS: undefined,
      COPSE_CURSOR_API_KEY: undefined,
      COPSE_COMMENT_TEMPLATES: "/path/to/templates",
    },
    () => {
      const config = loadEnvConfig();
      assert.equal(config.commentTemplates, "/path/to/templates");
    }
  );
});

test("loadEnvConfig returns empty object when no env vars are set", () => {
  withEnv(
    {
      COPSE_REPOS: undefined,
      COPSE_CURSOR_API_KEY: undefined,
      COPSE_COMMENT_TEMPLATES: undefined,
    },
    () => {
      const config = loadEnvConfig();
      assert.equal(config.repos, undefined);
      assert.equal(config.cursorApiKey, undefined);
      assert.equal(config.commentTemplates, undefined);
    }
  );
});

test("loadConfig env vars take precedence over .copserc file values", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(
      join(dir, ".copserc"),
      JSON.stringify({
        repos: ["file/repo1"],
        cursorApiKey: "file-key",
        commentTemplates: "/file/templates",
      })
    );

    withEnv(
      {
        COPSE_REPOS: "env/repo1,env/repo2",
        COPSE_CURSOR_API_KEY: "env-key",
        COPSE_COMMENT_TEMPLATES: "/env/templates",
      },
      () => {
        const config = loadConfig(dir);
        assert.deepEqual(config?.repos, ["env/repo1", "env/repo2"]);
        assert.equal(config?.cursorApiKey, "env-key");
        assert.equal(config?.commentTemplates, "/env/templates");
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig uses .copserc values when env vars are not set", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(
      join(dir, ".copserc"),
      JSON.stringify({
        repos: ["file/repo1"],
        cursorApiKey: "file-key",
      })
    );

    withEnv(
      {
        COPSE_REPOS: undefined,
        COPSE_CURSOR_API_KEY: undefined,
        COPSE_COMMENT_TEMPLATES: undefined,
      },
      () => {
        const config = loadConfig(dir);
        assert.deepEqual(config?.repos, ["file/repo1"]);
        assert.equal(config?.cursorApiKey, "file-key");
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig returns config from env vars alone when no .copserc exists", () => {
  const dir = makeTempDir();
  try {
    withEnv(
      {
        COPSE_REPOS: "env/only-repo",
        COPSE_CURSOR_API_KEY: undefined,
        COPSE_COMMENT_TEMPLATES: undefined,
      },
      () => {
        const config = loadConfig(dir);
        assert.deepEqual(config?.repos, ["env/only-repo"]);
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig returns null when no env vars and no .copserc", () => {
  const dir = makeTempDir();
  try {
    withEnv(
      {
        COPSE_REPOS: undefined,
        COPSE_CURSOR_API_KEY: undefined,
        COPSE_COMMENT_TEMPLATES: undefined,
      },
      () => {
        const config = loadConfig(dir);
        assert.equal(config, null);
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadConfig partial env override preserves file values for unset env vars", () => {
  const dir = makeTempDir();
  try {
    writeFileSync(
      join(dir, ".copserc"),
      JSON.stringify({
        repos: ["file/repo"],
        cursorApiKey: "file-key",
        commentTemplates: "/file/templates",
      })
    );

    withEnv(
      {
        COPSE_REPOS: "env/repo",
        COPSE_CURSOR_API_KEY: undefined,
        COPSE_COMMENT_TEMPLATES: undefined,
      },
      () => {
        const config = loadConfig(dir);
        assert.deepEqual(config?.repos, ["env/repo"]);
        assert.equal(config?.cursorApiKey, "file-key");
        assert.equal(config?.commentTemplates, "/file/templates");
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("getConfiguredRepos returns repos from env vars", () => {
  const dir = makeTempDir();
  try {
    withEnv(
      {
        COPSE_REPOS: "env/repo1,env/repo2",
        COPSE_CURSOR_API_KEY: undefined,
        COPSE_COMMENT_TEMPLATES: undefined,
      },
      () => {
        const repos = getConfiguredRepos(dir);
        assert.deepEqual(repos, ["env/repo1", "env/repo2"]);
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
