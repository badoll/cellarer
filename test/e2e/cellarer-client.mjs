import { promises as fs } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { runSubprocess } from "./harness-boundaries.mjs";

export async function createCellarerClient({
  command,
  consumerRoot,
  repositoryRoot,
  cwd,
  env,
  testRoot,
  secretCanaries = [],
}) {
  if (!isAbsolute(command)) throw new Error("installed cellarer command must be absolute");
  const commandStat = await fs.lstat(command);
  if (!commandStat.isFile() || commandStat.isSymbolicLink()) {
    throw new Error("installed cellarer command must be a regular command shim");
  }
  if ((commandStat.mode & 0o111) === 0)
    throw new Error("installed cellarer command is not executable");
  const realCommand = await fs.realpath(command);
  const realConsumerRoot = await fs.realpath(consumerRoot);
  const realRepositoryRoot = await fs.realpath(repositoryRoot);
  if (!isInside(realConsumerRoot, realCommand)) {
    throw new Error(`installed cellarer command resolves outside consumer: ${realCommand}`);
  }
  if (isInside(realRepositoryRoot, realCommand)) {
    throw new Error(`installed cellarer command resolves into workspace source: ${realCommand}`);
  }

  return Object.freeze({
    command: realCommand,
    consumerRoot: realConsumerRoot,
    async invoke(identity, args, options = {}) {
      const result = await runSubprocess({
        command: realCommand,
        args: ["--output", "json", "--non-interactive", ...args],
        cwd,
        env,
        testRoot,
        stdin: options.stdin,
        allowFailure: true,
      });
      const raw = `${result.stdout}\n${result.stderr}`;
      for (const canary of secretCanaries) {
        if (typeof canary === "string" && canary.length > 0 && raw.includes(canary)) {
          throw new Error(`protocol output disclosed a secret canary during ${identity}`);
        }
      }
      if (result.signal !== null || result.code === null) {
        throw new Error(`cellarer ${identity} did not exit normally`);
      }
      let envelope;
      try {
        envelope = JSON.parse(result.stdout);
      } catch {
        throw new Error(`cellarer ${identity} did not emit one JSON protocol envelope`);
      }
      if (!isRecord(envelope) || envelope.protocolVersion !== "1.0") {
        throw new Error(`cellarer ${identity} emitted an invalid protocol envelope`);
      }
      if (envelope.command !== identity) {
        throw new Error(
          `cellarer command identity mismatch: expected ${identity}, received ${String(envelope.command)}`,
        );
      }
      const success = result.code === 0 && envelope.status === "success";
      const domainError = result.code !== 0 && envelope.status === "error";
      if (!success && !domainError) {
        throw new Error(`cellarer ${identity} exit code and protocol status disagree`);
      }
      const exitClass = success ? "success" : "domain-error";
      return Object.freeze({
        identity,
        exitClass,
        envelope,
        evidence: Object.freeze({
          command: identity,
          exitClass,
          exitCode: result.code,
          stdout: "protocol-json",
          stderr: result.stderr.length === 0 ? "empty" : "diagnostic",
        }),
      });
    },
  });
}

function isInside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
