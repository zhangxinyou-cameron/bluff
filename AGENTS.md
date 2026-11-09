# Repository workflow

- The active repository is `E:\bluff`. Do not edit older copies in `E:\server` or `E:\update` unless the user asks.
- Implement and verify requested changes, then write a clear entry in `CHANGELOG.md` and update relevant usage/validation notes.
- The user has requested that completed updates be pushed to both repositories: Gitee `origin/master` and GitHub `github/main`.
- Commit the finished changes on local `master`, then run `npm run push:all`. Verify that both remote hashes match the local commit before reporting full synchronization.
- Preserve remote history; do not force-push. If either push fails, report which service remains unsynced and keep the local commit available for retry.
- Runtime executables, local data, dependencies and generated test outputs remain excluded by `.gitignore`.
