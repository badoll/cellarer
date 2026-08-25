import {
  type CommandDomain,
  defineCommandDomain,
  defineContractMetadata,
} from "../protocol/command-contract.js";
import { commandSchemaFragments as s } from "../protocol/command-schema-fragments.js";
import { createAgentsCommandContract } from "./agents.js";
import { createDoctorCommandContract } from "./doctor.js";
import { createStatusCommandContract } from "./status.js";
import { createUiCommandContract } from "./ui.js";

export function createDiagnosticsServiceDomain(): CommandDomain {
  return defineCommandDomain({
    id: "diagnostics-service",
    contracts: [
      createAgentsCommandContract(
        defineContractMetadata({
          command: "agents",
          catalogOrder: 2,
          mutability: "read",
          input: s.scopeInput(),
          bindings: s.scopeBindings(),
          output: s.dataObject(["storeRoot", "scope", "agents"], {
            storeRoot: s.jsonSchema.string(),
            scope: s.jsonSchema.enumeration(["global", "project"]),
            dir: s.jsonSchema.string({ minLength: 1 }),
            agents: s.jsonSchema.array(s.inspectedAgent),
          }),
        }),
      ),
      createStatusCommandContract(
        defineContractMetadata({
          command: "status",
          catalogOrder: 8,
          mutability: "read",
          input: s.scopeInput(),
          bindings: s.scopeBindings(),
          output: s.dataObject(["items"], {
            items: s.jsonSchema.array(s.statusItem),
            verification: s.verifyOutput,
          }),
        }),
      ),
      createDoctorCommandContract(
        defineContractMetadata({
          command: "doctor",
          catalogOrder: 12,
          mutability: "read",
          input: s.scopeInput(),
          bindings: s.scopeBindings(),
          output: s.dataObject(
            ["storeRoot", "scope", "checks", "agents", "mutationRecovery", "limitations"],
            {
              storeRoot: s.jsonSchema.string(),
              scope: s.jsonSchema.enumeration(["global", "project"]),
              dir: s.jsonSchema.string({ minLength: 1 }),
              defaultMethod: s.jsonSchema.enumeration(["symlink", "copy"]),
              checks: s.jsonSchema.array(s.diagnosticCheck),
              agents: s.jsonSchema.array(s.doctorAgent),
              mutationRecovery: s.mutationRecoveryPresentation,
              limitations: s.jsonSchema.array({
                oneOf: [
                  s.dataObject(["capability", "code", "reason"], {
                    capability: { const: "native-keychain" },
                    code: { const: "KEYCHAIN_MODULE_UNAVAILABLE" },
                    reason: { const: "module-unavailable" },
                  }),
                  s.dataObject(["capability", "code", "reason"], {
                    capability: { const: "native-keychain" },
                    code: { const: "KEYCHAIN_SMOKE_ISOLATION_UNAVAILABLE" },
                    reason: { const: "credential-store-not-isolated" },
                  }),
                ],
              }),
            },
          ),
        }),
      ),
      createUiCommandContract(
        defineContractMetadata({
          command: "ui",
          catalogOrder: 13,
          mutability: "service",
          requiredFeatures: [
            "long-running-process",
            "protected-secret-channel",
            "lifetime-channel",
          ],
          input: s.jsonSchema.object({
            port: s.jsonSchema.integer(0, 65_535),
            tokenFd: s.jsonSchema.integer(s.PROTECTED_DESCRIPTOR_MIN, s.PROTECTED_DESCRIPTOR_MAX),
            lifetimeFd: s.jsonSchema.integer(
              s.PROTECTED_DESCRIPTOR_MIN,
              s.PROTECTED_DESCRIPTOR_MAX,
            ),
          }),
          bindings: [
            s.option("port", undefined, s.stringify),
            s.option("tokenFd", undefined, s.stringify),
            s.option("lifetimeFd", undefined, s.stringify),
          ],
          output: s.dataObject(
            [
              "schemaVersion",
              "apiVersion",
              "contractId",
              "lifecycle",
              "authMode",
              "pid",
              "baseUrl",
            ],
            {
              schemaVersion: { const: 1 },
              apiVersion: { const: "1.0" },
              contractId: { const: "cellarer-local-client-api-v1" },
              lifecycle: { const: "owned-v1" },
              authMode: s.jsonSchema.enumeration(["bearer", "browser-session"]),
              pid: s.jsonSchema.integer(1),
              baseUrl: s.jsonSchema.string({ pattern: "^http://127\\.0\\.0\\.1:[1-9][0-9]*$" }),
            },
          ),
        }),
      ),
    ],
  });
}
