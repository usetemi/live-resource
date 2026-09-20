# live-resource

`README.md` owns the contract, the protocol, and the reasons behind them. Read it first.

- Minimize maintained code. Reject speculative resources, configuration, layers, and
  duplicate state. The protocol values and the `live_resource` channel are fixed, not options.
- Preserve authorization on open, before notifications, and on heartbeats; serialized
  reads; cancellation; subscribe-before-read ordering; and recovery.
- The package imports nothing from `next` and nothing application-specific. `src/index.tsx`
  is the client entry, `src/server.ts` the Node entry; `pg` and `react` are peers.
- No unit tests. Evidence is `tests/live-resource.spec.ts`: a real browser against
  `example/`'s production build, the packed tarball, and Postgres in Docker. Assert
  behavior a user could observe, not protocol constants.
- Prose, examples, and identifiers do not name any consuming application.
- Run `npm run check` before handoff. It needs Docker.
- Release: bump `package.json` and `CHANGELOG.md`, merge, then publish a GitHub Release
  tagged `vX.Y.Z`. `release.yml` publishes through npm trusted publishing; there is no token.
