## Context

The repository already produces three deterministic public tarballs and the CLI manifest already maps the executable name `cellarer` to `dist/bin.js`. The artifact gate installs those tarballs into an isolated consumer, but invokes the generated bin by absolute path; the root documentation therefore still treats `node packages/cli/dist/bin.js` as the supported interface and all public packages remain at `0.1.0-alpha.0`.

This change promotes the existing distribution architecture instead of inventing another launcher. The workspace root remains an unpublished coordinator, while `@cellarer/core`, `@cellarer/web`, and `@cellarer/cli` remain the public package set.

## Goals / Non-Goals

**Goals:**

- Prepare the synchronized stable package version `0.1.0`.
- Prove that a clean consumer resolves and runs `cellarer` by command name from its installed command path.
- Make `cellarer <command>` the canonical user-facing command throughout public documentation.
- Keep a truthful distinction between locally ready release artifacts and an externally published npm release.

**Non-Goals:**

- Publishing to npm, creating a git tag or GitHub release, changing a dist-tag, or deploying anything.
- Renaming the public CLI package from `@cellarer/cli`, collapsing the three packages, or making the monorepo root publishable.
- Changing CLI command semantics, protocol schemas, Store data, or supported runtime platforms.
- Adding a compatibility launcher for the source-tree `node .../bin.js` path.

## Decisions

### Use `0.1.0` as the first stable version

The current packages are synchronized at `0.1.0-alpha.0`; removing the prerelease suffix preserves the already selected minor line and communicates the first stable release without claiming a mature `1.0.0` compatibility commitment. `prepare-version.mjs` remains the single writer for synchronized versions and exact internal dependency ranges.

The CLI's frozen command-surface fixture includes the displayed package version. It will advance only that version field to `0.1.0`; any other fixture diff would indicate an undeclared command-contract change and must fail review.

Alternative considered: publish another alpha or release candidate. That would retain the exact product-state mismatch the user asked to remove.

### Keep `@cellarer/cli` as the package and `cellarer` as the command

Package identity and executable identity are separate npm contracts. The existing scoped package owns the thin CLI while the `bin` field gives users the unscoped `cellarer` command after installation. Keeping this boundary avoids a package rename and preserves the existing Core/Web dependency graph.

Alternative considered: publish the private monorepo root as `cellarer`. That would mix workspace orchestration with the runtime artifact and contradict the accepted private-root distribution contract.

### Exercise command lookup rather than an absolute generated bin path

The artifact consumer environment will prepend its installed `.bin` directory to `PATH`, and ordinary release checks will spawn `cellarer`. The gate will still retain the resolved JavaScript path only for the unsupported-Node preload probe, which specifically needs to execute Node with a preload before the CLI entrypoint.

This tests the user-visible boundary: package installation creates a command that works from an unrelated working directory without source-tree paths.

### Separate product usage from contributor execution

Public workflows will use `cellarer`. The docs will first describe installation from the public package, while clearly saying that registry publication is a separate external step until it happens. Source checkout commands remain only in the Development and release section for contributors and release maintainers.

## Risks / Trade-offs

- **The npm scope may not be owned or authenticated on the release machine** → Do not publish in this change; verify package names against the public registry as a non-authoritative availability signal and require explicit authenticated publication later.
- **Documentation could claim a package is downloadable before it is published** → State that `0.1.0` artifacts are locally release-ready and label registry installation as the post-publication path.
- **PATH-based acceptance could accidentally resolve another global `cellarer`** → Prepend the isolated consumer `.bin` directory and assert the installed executable and JavaScript entry remain inside the consumer root.
- **A stable version bump is difficult to undo after publication** → Publication is excluded; before publication, rollback is a normal manifest/doc revert. After publication, npm immutability requires a later patch version rather than rewriting `0.1.0`.

## Migration Plan

1. Prepare Core, Web, and CLI manifests at `0.1.0` with exact synchronized internal dependencies.
2. Update the artifact gate and public documentation, then run focused version and artifact checks.
3. Run the normal full repository closure gate and archive the OpenSpec change.
4. In a separately authorized operation, publish Core, Web, then CLI at `0.1.0`, verify `npm install --global @cellarer/cli`, and only then create any release tag or announcement.

Rollback before publication consists of reverting the local manifest and documentation changes. No Store or user data migration is involved.

## Open Questions

None for local release preparation. npm organization ownership, authentication, and publication timing are external release inputs and remain intentionally unresolved here.
