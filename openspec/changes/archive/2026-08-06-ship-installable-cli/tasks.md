## 1. Version and Package Metadata

- [x] 1.1 Choose and document the first pre-release version and supported Node/OS matrix
- [x] 1.2 Add a checked local version-preparation script that keeps Core, Web, and CLI versions/dependency ranges synchronized while the root remains private
- [x] 1.3 Make Core, Web, and CLI package manifests packable with correct exports, files, license, README, engines, and publish metadata
- [x] 1.4 Source CLI version output from installed build/package metadata

## 2. Runtime Assets and Optional Native Support

- [x] 2.1 Resolve Core config/schema and Web client assets from installed ESM module locations rather than current working directory
- [x] 2.2 Verify the bin shebang and executable mode survive build and pack
- [x] 2.3 Make keychain loading/install optional and add typed encrypted-vault fallback tests without real user secrets

## 3. Artifact Release Gate

- [x] 3.1 Add deterministic build/pack inspection for synchronized manifests, publishable dependency ranges, allowlisted files, integrity, and secret canaries
- [x] 3.2 Install the packed release set into a clean temporary project with isolated home/store paths and no workspace module resolution
- [x] 3.3 Exercise installed version, capabilities/schema, doctor/init dry-run, and a minimal multi-agent resource management journey
- [x] 3.4 Start installed `cellarer ui` on loopback and verify dashboard/static assets from the packed Web package
- [x] 3.5 Prove unsupported Node startup fails before mutation and native-unavailable install uses the vault fallback

## 4. CI and Documentation

- [x] 4.1 Run the same installed-artifact gate across the documented supported Node/OS CI matrix
- [x] 4.2 Add local pack/readiness commands that cannot publish, tag, release, change dist-tags, or deploy
- [x] 4.3 Synchronize English and Chinese installation, npx, runtime requirements, package contents, and maintainer release-gate documentation

## 5. Single-Executable Decision and Final Gates

- [x] 5.1 Time-box a Node single-executable prototype covering ESM loading, Web/config assets, optional native modules, size, startup, signing, and cross-platform build effort
- [x] 5.2 Record an evidence-backed go/no-go decision without making npm readiness depend on a go result
- [x] 5.3 Run the artifact release gate plus `pnpm test`, `pnpm lint`, `pnpm typecheck`, and `pnpm build`
