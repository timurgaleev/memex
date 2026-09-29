/**
 * Toolchain pins — the typecheck gate must not be able to change meaning
 * without a reviewable diff.
 *
 * `bunx tsc --noEmit` is a ship gate, so the compiler and the ambient Bun
 * typings are as load-bearing as any dependency. A floating range lets a
 * plain reinstall move either one, which silently re-scopes what the gate
 * accepts or rejects. bunfig's `frozenLockfile` covers the normal install
 * path, but the manifest is what a `bun update` re-resolves from — so the
 * pin has to live here too.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const pkgDir = join(import.meta.dir, "..");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const dockerfile = readFileSync(join(pkgDir, "Dockerfile"), "utf8");

const EXACT = /^\d+\.\d+\.\d+$/;

describe("toolchain pins", () => {
  it.each(["typescript", "@types/bun"])("%s is pinned exactly", (dep) => {
    expect(pkg.devDependencies[dep]).toMatch(EXACT);
  });

  it("ships the Bun typings that match the runtime image", () => {
    // Types ahead of the runtime is the failure that costs a deploy: tsc goes
    // green against an API the container's Bun does not have yet. Tracking the
    // image's minor keeps the typings honest about what actually runs, while
    // still tolerating a patch skew — DefinitelyTyped does not publish a
    // release for every Bun patch.
    const images = [...dockerfile.matchAll(/oven\/bun:(\d+\.\d+)\.\d+/g)].map(m => m[1]);
    expect(images.length).toBeGreaterThan(0);
    expect(new Set(images).size).toBe(1);

    const typesMinor = pkg.devDependencies["@types/bun"].split(".").slice(0, 2).join(".");
    expect(typesMinor).toBe(images[0]);
  });
});
