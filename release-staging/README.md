# release-staging — AppOS Catalog Bundle Layout v1

A published bundle zip carries **two manifests** because the catalog and the
desktop runtime read different schemas: the catalog `manifest-v1` document
sits at the zip root as `manifest.json` (the only member the catalog's
publish-time candidate scan may see), while the AppOS runtime manifest — the
repo's root `plugin.json` — rides at `appos/runtime/plugin.json`, two levels
deep and therefore invisible to that scan. A `plugin.json` at the zip root or
one level deep would either fail catalog validation (`manifest_invalid`) or
make the scan ambiguous (`ambiguous_bundle_root`). The desktop installer
normalizes the nested runtime manifest back to the plugin root at install
time, so the installed tree activates unchanged. Full rationale and contract:
AppOS desktop repo `docs/PLUGIN-DEV-GUIDE.md` §2.1 "Publishing to the
catalog: bundle layout".

Files here:

- `stage_release.sh` — reproducible staging: builds
  `space-appos-ytdlp-<version>.zip` in this layout from the dev tree and
  self-checks it (catalog candidate predicate, manifest coherence, entrypoint
  existence). `--check-zip <path>` runs the same checks against any zip.
- `manifest.json` — tracked source of truth for the catalog `manifest-v1`
  document (extracted from the published 1.1.0 seed zip).
- `publish_ytdlp.sh` — operator seeding script for the live catalog
  (prepare → upload → submit → claim → verify).

Built zips and signing keys stay untracked (`.gitignore`); the published
1.1.0 zip is live evidence and `stage_release.sh` refuses to overwrite an
existing zip without `--force`.
