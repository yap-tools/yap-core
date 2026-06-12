/**
 * The manager-only CLI package variant: yap-cli.tgz carries the `yap` bin
 * with zero runtime dependencies, derived at pack time from the real
 * package.json. The server package (yap-core.tgz) is untouched.
 */
import { describe, expect, it } from "vitest";

import { cliPackageJson, CLI_DIST_FILES } from "../../scripts/pack-cli.js";

const base = {
  name: "yap-core",
  version: "0.2.1",
  description: "Yap: API-first…",
  type: "module",
  license: "MIT",
  author: "Troels Abrahamsen",
  repository: { type: "git", url: "git+https://github.com/yap-tools/yap-core.git" },
  homepage: "https://github.com/yap-tools/yap-core#readme",
  bugs: { url: "https://github.com/yap-tools/yap-core/issues" },
  keywords: ["mcp"],
  engines: { node: ">=22" },
  bin: { yap: "dist/index.js" },
  files: ["dist", "drizzle", ".env.example"],
  scripts: { prepare: "npm run build", build: "tsc -p tsconfig.build.json" },
  dependencies: { "better-sqlite3": "^12.10.0", pg: "^8.21.0" },
  devDependencies: { vitest: "^4.1.8" },
};

describe("cliPackageJson", () => {
  const pkg = cliPackageJson(base);

  it("renames the package and keeps the bin and version", () => {
    expect(pkg.name).toBe("yap-cli");
    expect(pkg.version).toBe("0.2.1");
    expect(pkg.bin).toEqual({ yap: "dist/index.js" });
  });

  it("has zero dependencies of any kind", () => {
    expect(pkg.dependencies).toBeUndefined();
    expect(pkg.devDependencies).toBeUndefined();
  });

  it("drops scripts so packing the staged dir never runs prepare/build", () => {
    expect(pkg.scripts).toBeUndefined();
  });

  it("ships only dist (no drizzle migrations, no .env.example)", () => {
    expect(pkg.files).toEqual(["dist"]);
  });

  it("carries identity fields through", () => {
    expect(pkg.license).toBe("MIT");
    expect(pkg.engines).toEqual({ node: ">=22" });
    expect(pkg.repository).toEqual(base.repository);
  });
});

describe("CLI_DIST_FILES", () => {
  it("covers the entry, the cli and instance trees, and crypto — nothing server-side", () => {
    expect(CLI_DIST_FILES).toContain("index.js");
    expect(CLI_DIST_FILES).toContain("crypto.js");
    expect(CLI_DIST_FILES).toContain("cli");
    expect(CLI_DIST_FILES).toContain("instance");
    expect(CLI_DIST_FILES).not.toContain("serve.js");
    expect(CLI_DIST_FILES).not.toContain("server.js");
  });
});
