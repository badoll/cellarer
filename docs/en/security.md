# Security

[Documentation index](../README.md) | [简体中文](../zh-CN/security.md)

cellarer is a local configuration tool, but it still treats secret handling as a
hard boundary.

## Plaintext Secret Boundary

Stored resources and generated files must not contain plaintext secrets. Use
references instead:

```json
{
  "command": "example-server",
  "env": {
    "OPENAI_API_KEY": "${OPENAI_API_KEY}"
  }
}
```

or:

```json
{
  "command": "example-server",
  "env": {
    "OPENAI_API_KEY": "${CELLARER_SECRET:OPENAI_API_KEY}"
  }
}
```

## Reference-Only Rendering

Distribution preserves supported environment and cellarer reference tokens. It
does not read a vault, keychain, or environment value while rendering target
configuration, regardless of `secretMode`.

MCP adapters declare `supportedSecretReferences`. Planning skips an adapter when
selected content uses a reference kind that the target cannot consume natively;
cellarer never falls back to writing the resolved value.

Compatibility is explicit:

| Reference | Compatible target |
| --- | --- |
| `${ENV_VAR}` | The adapter declares `environment` support and the agent process receives that environment variable outside cellarer's generated-file path. |
| `${CELLARER_SECRET:name}` | The adapter declares `cellarer` support and the target resolves that token natively. |

Only the Claude Code and Gemini CLI built-ins currently declare `environment`
support for the generic renderer's exact `${ENV_VAR}` output. Codex requires a
structural `env_vars` facility, OpenCode uses `{env:NAME}`, Windsurf uses
`${env:NAME}`, and Cursor has no verified exact `${VAR}` contract here. Those
four adapters declare no reference support and planning fails closed until an
adapter-specific translation is implemented. No built-in currently declares
`cellarer` support. See [Custom Adapters](adapters.md) for the compatibility
table. `secretMode` selects the provider used for presence verification and
known-value scanning; it does not authorize plaintext rendering.

## Import and Scan Guards

- `add` rejects import sources that contain high-confidence plaintext secrets.
- `scan` redacts structured MCP secret fields before store writes.
- Store writes run a final plaintext guard.
- Skill files ending in `.json`, `.jsonc`, `.yaml`, `.yml`, or `.toml` receive
  the same strict per-file structured detector during import and final staging.
  One shared classifier tokenizes lower, snake_case, kebab-case, dotted,
  camelCase, and PascalCase names before matching the explicit sensitive-field
  vocabulary. For example, `access_token`, `access-token`, `access.token`,
  `accessToken`, `AccessToken`, `refreshToken`, and `clientSecret` are
  equivalent sensitive shapes. Plural and fused forms such as `passwords`,
  `passphrases`, `accessKeys`, `privatekeys`, `clientsecrets`, and `apiKeys`
  are explicit members of the same vocabulary, while unrelated substrings such
  as `monkey`, `tokenizer`, and `secretariat` are not. Sensitive context is inherited by every array item and object
  descendant. Strings, numbers, booleans, and null are findings in that context;
  only an exact `${ENV_VAR}` or `${CELLARER_SECRET:name}` string and the existing
  empty-string representation are safe. Shell defaults such as
  `${MISSING:-hunter2}` remain plaintext findings. JSON and JSONC duplicate keys
  are rejected from the captured source bytes before last-wins parsing can
  discard an earlier value. Malformed or unsupported ambiguous structured
  content fails closed instead of falling back to lexical scanning.
- `reference`, `references`, and `secretRefs` are sensitive field names, not
  metadata bypasses. Their plaintext scalar or container descendants are
  blocked or redacted; only exact supported typed-reference strings pass. The
  internal ownership ledger preserves its validated reference-name metadata
  only through a dedicated exact-key protocol serializer, never through a
  global observable exception. `secretMode` remains a narrow non-secret enum.
- YAML sensitive context covers both indented and valid indentless sequences.
  Every item below a key such as `password:` inherits that context, including
  nested arrays and objects.
- Captured MCP source receives the same strict structured inspection before an
  import can publish a durable plan or active journal. Predictable validation
  rejection leaves no active recovery state. The final serialized-byte guard
  remains in place as defense in depth.
- A raw sensitive command flag such as `--password` makes its complete following
  value sensitive before command normalization. Non-reference strings, numbers,
  booleans, null, arrays, and objects block add/scan before provider access,
  durable-plan creation, or journal publication.
- Skill directories containing symlinks are rejected during `add` because the
  symlink target cannot be safely scanned as store content.
- A regular single Rule or MCP file uses a portable lstat/open/fstat identity
  handshake before and after reading, including on Windows. Recursive Skill
  capture is a separate dependency-free boundary supported on Darwin/Linux
  x64/arm64. It anchors traversal in an isolated Node process, uses no-follow
  opens for direct children, and rechecks stable identities before accepting a
  snapshot. Unsupported recursive platforms fail closed before reading or
  copying directory content and do not disable the safe single-file path.

MCP compatibility checks recursively discover typed references in normalized
fields, stdio/remote extension data, arrays, and custom server configuration.
An adapter that does not support any discovered kind is rejected before target
rendering.

## Web UI Security

The Web server:

- listens on `127.0.0.1` and starts in exactly one explicit authentication mode
- reads managed bearer material only from a protected inherited descriptor, never argv,
  environment fallback, a URL, a ready record, or an HTTP response
- gives the bundled browser a new random `HttpOnly`, `SameSite=Strict`, `/api/v1`-scoped
  session on every start after exact Host, Origin, and Fetch Metadata checks
- validates exact loopback Host on static, bootstrap, discovery, read, and mutation routes,
  and requires exact Origin on every browser mutation
- keeps only `/api/v1/health` unauthenticated; authenticated readiness reports typed
  Store, authority, lock, and recovery blockers without provider or path details
- returns reference-only plans and applies the final serialization guard to every
  `/api/v1` JSON response

The unversioned `/api/*` routes and query-token behavior do not exist. Managed
ownership uses a separate inherited lifetime descriptor; EOF, programmatic
close, SIGINT, and SIGTERM enter the same bounded shutdown path. Forced
connection close never deletes a Core journal or guesses recovery state.

The CLI composition root preloads the Store-scoped mutation authority before it
starts Web. Web receives only the narrow in-memory `MutationAuthority`
capability required for sealing, current-epoch leases, and protected journal
tips. It receives no general `SecretStore`, raw key, credential-provider handle,
or authority lifecycle operation. Web scan/import composition always forces
environment-reference mode and performs no vault or keychain secret calls.
Without a usable authority, read-only scan planning remains available while
executable import and other mutation routes fail closed.

Core error serialization, CLI JSON output, and Web JSON responses use the same
sensitive-field classifier and inherited container context as the structured
guards. Every non-reference descendant scalar is replaced with `[REDACTED]`
without returning the original value or a reversible derivative; exact
supported reference strings and the empty-string representation remain intact.

## Mutation Authority

Every executable plan, durable plan, and journal publication is authenticated by
a domain-separated HMAC authority in addition to its unkeyed integrity digest.
The seal binds the normalized Store root, operation, base revision, exact
canonical payload, authority id, and epoch. A digest is not authority.

Composition resolves `CELLARER_HOME` to an absolute physical path through the
injected `realpath` effect before deriving the credential account, headless
kernel owner, Core or Web mutation scope, seal, journal, or lock path. Relative,
symlink, and filesystem case aliases therefore share one identity. Only `init`
may create a missing Store root before canonicalization; other authority paths
do not create it as a side effect.

For normal local use, `cellarer init` loads or creates a random 256-bit master key
in the OS credential manager under an account derived from the normalized Store
root. Provisioning succeeds only after exact read-back verification. Core sees
only a non-serializable seal/verify capability; the raw key never enters the
Store or observable output.

The credential service `dev.cellarer.mutation-authority.v1` and every account
beginning with `__cellarer_internal__:mutation-authority:v1:` are reserved for
authority material and protected journal tips. Ordinary secret create, read,
update, and delete paths reject either namespace before provider access, and the
internal account grammar cannot be addressed by `${CELLARER_SECRET:name}`.
Never inspect, edit, or delete these entries through `cellarer secret` or a
general credential-management script.

Headless/CI operation may use only `CELLARER_MUTATION_AUTHORITY`, encoded as
`v1:<positive-epoch>:<43-character-unpadded-base64url-key>` where the decoded key
is exactly 32 bytes. Supply it through the runner's protected secret-to-
environment facility. Never pass it through argv, JSON, config, Store files,
logs, stdout, or stderr. A malformed explicit value fails closed without
keychain fallback.

Headless composition establishes one non-replayable kernel process-lifetime
owner per Store before executable planning. The injected `Env` capability binds
an exclusive listener only on `127.0.0.1` at a deterministic Store-scoped local
port, never connects to an incumbent, and unreferences the listener. Another
process cannot make the same or a different epoch current while that kernel
lease is live; process exit releases it automatically. Store bytes are never
authority evidence, so deleting, replacing, or replaying an old owner-shaped
file cannot revive a stale capability. An unrelated local listener or port
collision fails closed rather than being probed or trusted.

First provisioning and rotation share a Store-scoped authority coordination
boundary. Rotation additionally excludes mutation and recovery and is refused
while any active journal exists. Execution checks currentness before canonical
replanning, while holding the authority lease, and again under the Store
mutation lock. This gives rotation, mutation, and recovery one serial order and
prevents a stale long-running process from observing product state or performing
external effects after a newer epoch wins.

Every mutating Core entry point, including apply, add, and scan-apply, and every
recovery diagnosis checks currentness and obtains the same operation lease
before reading config, journals, protected tips, locks, receipts, registries,
ledgers, or targets. Currentness is checked before and after lease acquisition;
the existing mutation-lock recheck remains an independent final gate.

`cellarer authority rotate` rotates only the OS-keychain authority. It refuses
to proceed while any active journal exists. Success advances the epoch and
invalidates every old plan and journal. For headless operation, replace the
protected runner value with a higher epoch only after proving that there is no
active journal. A moved or cloned Store has a different scope and requires a
separate authority.

If the provider is locked or unavailable, restore the existing credential or
protected environment value. Do not delete the active journal, silently create
an ephemeral key, or rotate during recovery. Unsigned, cross-Store, unknown-
epoch, and prior-epoch records are rejected without legacy compatibility and
remain manual-recovery-only. Read-only CLI operations remain usable without
claiming that such records are safe.

Credential-manager composition anchors each latest journal publication outside
the Store with a protected `{ operationId, sequence, seal }` tip. Automatic
recovery requires an exact match. A missing, unreadable, stale, or mismatched tip
makes recovery manual-only before claims, providers, product-state observation,
or compensation, including replay of an older otherwise valid journal.

The explicit headless channel has no protected persistent monotonic storage, so
its tip exists only in the authority instance that observed each publication.
After process exit or restart, an active journal is manual-only even if the same
headless environment value is restored. Do not delete the journal, provision a
replacement authority, or rotate the epoch to bypass this limit.

`scan --dry-run` is an authority-optional read-only operation: it forces
environment-reference mode and neither provisions nor queries authority, vault,
or keychain credentials. This exception does not apply to an executable import
or to `apply --dry-run`, which produces an executable mutation plan and therefore
requires authority.

## Safe Secret Input

Do not put a new secret value in a positional argument or option. For a human,
run `secret add <name>` in a terminal; cellarer reads and confirms the value with
echo disabled, then reads the vault passphrase through another hidden prompt.
Production commands do not accept secret values or passphrases as option values.

For automation, provide exactly one protected input channel:

```bash
# The runner owns this current-user-only file and removes it after the command.
node packages/cli/dist/bin.js secret add OPENAI_API_KEY --stdin --passphrase-fd 3 3< "$CELLARER_VAULT_PASSPHRASE_FILE" < "$CELLARER_SECRET_INPUT_FILE"

# Use a separate inherited descriptor when stdin is occupied by structured input.
node packages/cli/dist/bin.js secret add OPENAI_API_KEY --fd 4 --passphrase-fd 3 3< "$CELLARER_VAULT_PASSPHRASE_FILE" 4< "$CELLARER_SECRET_INPUT_FILE"
```

Descriptor numbers must be 3 or greater. `--stdin` and `--fd` are mutually
exclusive, and a passphrase uses a separate descriptor. Values are not returned
on stdout or stderr.

## Rotate a Previously Exposed Secret

Treat any value previously written to a store artifact, generated target,
command argument, log, or response as compromised:

1. Revoke or rotate it at the upstream provider before reusing the integration.
2. Remove the old plaintext from source artifacts, generated targets, shell
   history, logs, and retained backups. Do not import the exposed value into the
   vault as a migration shortcut.
3. Store the replacement through hidden input, `--stdin`, or `--fd`, or arrange
   its environment value outside cellarer's generated configuration.
4. Replace configuration fields with a compatible reference token.
5. Inspect an `apply --dry-run` result, apply the clean plan, and run your
   repository or provider secret scanner. `status --json` can then confirm
   managed-target drift, but it is not a substitute for revocation or scanning.

## Known Limits

Secret detection is defensive but not perfect. Low-entropy passwords, custom
token formats, or credentials embedded in less typical fields may require manual
review. Treat `--dry-run`, code review, and repository scans as part of the
release process for sensitive changes.

Adapters that require cellarer to materialize plaintext are intentionally
incompatible. Use a target with native reference support instead of weakening
the reference-only boundary.
