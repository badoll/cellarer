## 1. Protocol Foundation

- [x] 1.1 Add golden tests for JSON envelopes, JSONL terminal records, stdout/stderr purity, exit classes, and redaction
- [x] 1.2 Define versioned public result/error/event DTOs and command-specific JSON Schemas
- [x] 1.3 Implement the typed command registry, protocol renderer, exit mapper, and request ID handling

## 2. Input and Non-Interactive Behavior

- [x] 2.1 Implement global `--output`, `--non-interactive`, and `--input <path|->` parsing and precedence
- [x] 2.2 Validate structured requests before Core invocation and reject argv/request domain-field ambiguity
- [x] 2.3 Remove prompt/default fallback from non-interactive paths and return typed input-required failures

## 3. Command Migration

- [x] 3.1 Convert all read-only commands to return public DTOs rendered by the shared protocol boundary
- [x] 3.2 Convert plan/apply/revert/secret/recovery commands and JSONL progress to the shared protocol boundary
- [x] 3.3 Remove ad hoc JSON shapes, incidental stdout logging, and command-local exit-code mapping

## 4. Discovery and Versioning

- [x] 4.1 Implement `cellarer capabilities` from the command registry
- [x] 4.2 Implement `cellarer schema` for individual schemas and the local schema bundle
- [x] 4.3 Replace hard-coded version output with installed package/build metadata and test packed artifacts

## 5. Compatibility Gates and Documentation

- [x] 5.1 Add a protocol conformance suite that invokes every command in JSON mode and validates stdout against its advertised schema
- [x] 5.2 Document machine input/output, exit/error mapping, JSONL completion, and capability discovery in synchronized public docs
- [x] 5.3 Run relevant Core and CLI tests, then run `pnpm lint`, `pnpm typecheck`, and `pnpm build`
