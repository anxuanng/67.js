// Prints the commit that the size, tool cost and archive checks compare a pull request with: node scripts/ci-base-sha.mjs
// It needs a checkout of the merge commit with at least two commits of history. The Test workflow runs it.
import { pullRequestBaseOf } from './size-base.mjs';

const base = pullRequestBaseOf();
if (!base) {
  console.error('HEAD is not a merge commit, so the pull request base is unknown. Check out the merge of the pull request with fetch-depth 2.');
  process.exit(1);
}
console.log(base);
