# Change notes

Each pull request adds one file here, such as `changes/issue-199.md`, with its changelog bullet exactly as it should read in `CHANGELOG.md`:

```md
- Add the `foo` option to `bar` (issue #123). It does this, measured as that.
```

Do not edit `CHANGELOG.md` in a pull request. Two pull requests then never touch the same file, so GitHub has nothing to conflict on.

`npm run changes` prints the pending notes. At release time `npm run changes:fold` writes them into `CHANGELOG.md` as the section for the version in `package.json` and deletes the files.

A size note, `changes/<issue>.size.md`, is not a changelog bullet. It accepts a bundle size increase, and `bench/size/README.md` says how. `changes:fold` leaves it out of the changelog and deletes it.
