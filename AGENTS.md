# live-resource

`README.md` owns the contract, the protocol, and the reasons behind them. Read it first.

- Minimize maintained code. Reject speculative resources, configuration, layers, and
  duplicate state. The protocol values and the `live_resource` channel are fixed, not options.
- Preserve authorization on open, before notifications, and on heartbeats; serialized
  reads; cancellation; subscribe-before-read ordering; and recovery.
- The package imports nothing from `next` and nothing application-specific. `src/index.tsx`
  is the client entry, `src/server.ts` the Node entry, `src/bin.ts` the `live-resource`
  command; `pg` and `react` are peers.
- No unit tests. Evidence is `tests/live-resource.spec.ts`: a real browser against
  `example/`'s production build, the packed tarball, and Postgres in Docker. Assert
  behavior a user could observe, not protocol constants.
- Prose, examples, and identifiers do not name any consuming application.
- Run `npm run check` before handoff. It needs Docker.
- `usage-rules.md` ships in the package as directives for a consumer's coding agent. Every
  change to what a consumer must know lands in `README.md` and `usage-rules.md` in the same
  PR; before a release, read both against the diff since the last tag. The block
  `src/bin.ts` writes carries no version, so a consumer's `--check` fails only when its
  wording changes.
- Release: bump `package.json` and `CHANGELOG.md`, merge, then publish a GitHub Release
  tagged `vX.Y.Z`. `release.yml` publishes through npm trusted publishing; there is no token.
