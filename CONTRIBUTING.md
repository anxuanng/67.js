# Contributing to 67.js

Thank you for helping. This file covers setup, the checks a change must pass, the code style and the release flow.

## Set up

1. Install Node.js 22.12 or later and Google Chrome.
2. Clone the repository and run `npm ci`.
3. Run `npm run dev`. Vite prints the local URL of the showcase.

The library source is in `src/` and the Node tools and smoke scripts are in `scripts/`.
The tests are in `tests/` and the guides are in `docs/`.
`public/` holds the site assets: previews, CC0 textures and the HDRI.

## Make a change

1. For a large feature, open an issue first, so that we agree on the design before you write it.
2. Create a branch from `main`.
3. Write the change and its tests in the same commit.
4. Update the guide in `docs/` that describes the feature.
5. Add a line to the top section of `CHANGELOG.md`.
6. Open a pull request that says what changed and how you checked it.

## Checks

Run these before you open a pull request:

1. Run `npm test`. All Node tests must pass.
2. Run `npm run build`. It builds the site and the viewers into `dist/`.
3. Run `npm run smoke:package` if you changed exports, `package.json` or the build. It installs the packed archive into a clean project.

A renderer or shader change also needs a look at real pixels.
Run `npm run smoke` or the `smoke:*` script for the area that you changed, and look at the screenshots that it saves under `artifacts/`.
A change to skinning, glTF loading, poses or IK also needs `npm run smoke:character`, which takes a real character through the MCP server. Run `npm run prepare:release` first.
Screenshots and other output go to `artifacts/`, which Git ignores.

Every pull request runs `npm test`, `prepare:release`, `smoke:package` and the protocol part of `smoke:mcp-package` in the `Test` workflow. The checks that need a GPU or look at pixels, such as `smoke:mcp` and `smoke:character`, do not run there, so run them yourself.

Do not weaken a test to make it pass. If a test is flaky, find the cause and fix the test or the code.

## Code style

- Use descriptive full names. Write `positionCount`, not `n` or `cnt`. Short names are fine for small loop indices.
- Write one statement on each line. Keep functions small.
- Add a comment only where the reason is not clear from the code.
- Keep the core renderer free of new runtime dependencies. Put optional features in an addon under `src/` and export it as `67js/addons/<name>`.
- Make every scene builder deterministic for the same seed. Tests compare geometry byte for byte.
- Validate input at the public boundary and throw an error that says what failed and what to pass instead.
- Measure a performance claim on matching scenes before you write it in the docs.

## Assets

Use only assets that you can share under CC0 or a license that allows redistribution.
Record the source, the author and the license of each asset in `public/textures/CREDITS.md`.
Keep site assets out of the npm package: the `files` list in `package.json` decides what ships.

`scripts/build-leaf-cards.py` rebuilds the leaf cards in `public/textures/leaves` from the ambientCG atlases. Its header gives the command.

## Release

Maintainers make releases. `package.json` holds the version, and the publish workflow runs when it changes on `main`.

1. Update the version in `package.json` and the matching section of `CHANGELOG.md`.
2. Run `npm test`, `npm run build` and `npm run smoke:package`.
3. Commit and push to `main`.
4. Wait for the `Publish 67js` workflow. It tests the package and publishes the new version through the npm trusted publisher.
5. Run `npm run deploy`. It checks that the tree is clean and pushed, builds the site and verifies the live `/release.json`.

## License

By contributing, you agree that your contribution is licensed under the [MIT License](LICENSE).
