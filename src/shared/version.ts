/**
 * This package's own version, read from its package.json. The compiler writes
 * it into pinned workflows as the actions' ref, so the workflows a version of
 * the compiler generates always run the actions that version shipped with.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

let cached: string | undefined;

/** e.g. "0.3.0". Works from source (src/shared/) and from the bundled CLI (dist/cli/): both sit two levels below package.json. */
export function packageVersion(): string {
  if (cached === undefined) {
    const path = fileURLToPath(new URL("../../package.json", import.meta.url));
    cached = (JSON.parse(readFileSync(path, "utf8")) as { version: string }).version;
  }
  return cached;
}

/** The git tag a release is cut under, and the ref pinned workflows use by default: `v<version>`. */
export function releaseTag(): string {
  return `v${packageVersion()}`;
}

/**
 * The ref older compilers wrote when a pinned config named none. It has not
 * moved since 0.1.2, so anything still on it runs actions far older than the
 * workflows around them.
 */
export const STALE_DEFAULT_REF = "v1";
