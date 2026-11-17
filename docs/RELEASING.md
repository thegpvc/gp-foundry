# Releasing

Pinned harnesses reference the runtime actions at the release's git tag
(`thegpvc/gp-foundry/actions/<name>@v<version>`), which the compiler writes when a
config names no `runtime.ref`. So a release is not finished until that tag exists:
without it, every pinned harness built with the new compiler points at nothing.

1. **Bump the version** on the release branch: `npm version <x.y.z> --no-git-tag-version`.
2. **Rebuild what the version is baked into**:
   - `npm run build:actions` (the action bundles),
   - `gp-foundry build` on `examples/starter` (its workflows carry the release tag).
   `npm test` fails until the example matches (`test/release-refs.test.ts`).
3. **Merge** to `main`.
4. **Tag the merge commit and push the tag**: `git tag v<x.y.z> && git push origin v<x.y.z>`.
5. **Publish**: `npm publish` from `main`.

Do the tag before the publish. Once the package is on npm, `npx @thegpvc/gp-foundry@latest`
starts generating workflows that reference the tag.

The `v1` tag is left at 0.1.2 on purpose. Moving it would put current actions under
workflows compiled months ago; `validate` warns when a config still names it.
