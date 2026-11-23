# mend

[![hidden-spec-cli-01](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![Rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/RenaldiRenaldi/hidden-spec-01/rank.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)
[![Reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/RenaldiRenaldi/hidden-spec-01/reward.svg)](https://make.fun/competitions/hidden-spec-cli-01-run-20261122)

`mend` applies AI-written edits to files under the current directory, using safe paths, fuzzy line matching and all-or-nothing writes.

Run it with Node 22: `node main.ts [--format=NAME] [--check] [--strict] [PATCH]`. It reads unified diffs, SEARCH/REPLACE blocks, V4A patches and JSON edits. Omit `PATCH` or pass `-` to read the patch from standard input.
