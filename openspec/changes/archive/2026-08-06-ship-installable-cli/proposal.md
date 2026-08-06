## Why

The monorepo currently declares Core, CLI, and Web as private `0.0.0` packages even though the CLI has a `cellarer` bin, and workspace tests do not prove that a developer can install and run the packed artifact elsewhere. The completed command surface is not real product capability until clean installation, runtime assets, native fallback, and version reporting work outside the repository.

## What Changes

- Keep the TypeScript/Node architecture and make the required workspace packages packable with synchronized real versions and correct public dependency metadata.
- Define the supported Node/platform matrix and ensure the executable bin, ESM output, Core config, Web client assets, license, and package documentation are present in tarballs.
- Add deterministic pack inspection plus clean temporary-environment install and CLI/UI smoke tests that never resolve workspace source paths.
- Make native keychain support optional at runtime and verify the encrypted-vault fallback on platforms without a compatible native binding.
- Add release gates for protocol schemas/capabilities, version output, integrity, package contents, and no secret/development-only artifacts.
- Add a time-boxed Node single-executable feasibility spike with a written go/no-go result; npm installation remains the required delivery path.
- Keep remote registry publication, Git tags/releases, Homebrew, and deployment outside this change and behind explicit release authorization.

## Capabilities

### New Capabilities
- `installable-cli-distribution`: Reproducible package artifacts, clean installation, executable/runtime asset validation, platform fallback, and release-readiness gates for the TypeScript/Node CLI.

### Modified Capabilities

None. This repository does not yet contain accepted capability specs to modify.

## Impact

This change follows the functional changes and affects package metadata, versioning/build scripts, tarball contents, CI release checks, native keyring loading, Web asset lookup, documentation, and release procedures. It prepares artifacts locally only and does not authorize publishing or modifying any remote service.
