# Retired characterization cases

These cases were removed from the active conformance catalog. Their old outcomes are not accepted
successes; reintroduce any scenario only after a shared required result is agreed (see issue #9).

- Alternate release/symbol-set behavior: `baseline/symbol-set`, `cli/process-symbol-set`,
  `next/baseline-symbol-set`, `release/none`.
- Deliberately absent injection or fixture-local CLI resolution outside the selected CLI dimension:
  `cli/upload-without-inject`, `cli/default-resolution`.
- Service fault paths whose old assertions accepted missing uploads, unresolved events or
  plugin-specific build failures: `auth/rejected-key`, `next/upload-start-500`,
  `nuxt/upload-start-500`, `release/resolve-fails`, `upload/check-forbidden`,
  `upload/finish-500`, `upload/r2-post-501`, `upload/start-500`.

The retained cases all require healthy builds, uploaded symbols, resolved exceptions and the
correct release on every event. Published-plugin deviations remain visible as failed cells.
