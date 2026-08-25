import {
  type CommandDomain,
  defineCommandDomain,
  defineContractMetadata,
} from "../protocol/command-contract.js";
import { commandSchemaFragments as s } from "../protocol/command-schema-fragments.js";
import { createAuthorityRotateCommandContract } from "./authority.js";
import { createOperationRecoverCommandContract } from "./control-plane-read.js";
import {
  createSecretAddCommandContract,
  createSecretListCommandContract,
  createSecretRemoveCommandContract,
} from "./secret.js";

export function createSecretAuthorityRecoveryDomain(): CommandDomain {
  return defineCommandDomain({
    id: "secret-authority-recovery",
    contracts: [
      createAuthorityRotateCommandContract(
        defineContractMetadata({
          command: "authority.rotate",
          catalogOrder: 5,
          mutability: "write",
          requiredFeatures: ["mutation-authority"],
          input: s.jsonSchema.object(),
          bindings: [],
          output: s.dataObject(["operation"], {
            operation: s.dataObject(["rotated"], { rotated: { const: true } }),
          }),
        }),
      ),
      createSecretAddCommandContract(
        defineContractMetadata({
          command: "secret.add",
          catalogOrder: 9,
          mutability: "write",
          requiredFeatures: ["protected-secret-channel"],
          input: s.jsonSchema.object(
            {
              name: s.jsonSchema.string({ minLength: 1 }),
              provider: s.provider,
              stdin: s.jsonSchema.boolean(),
              fd: s.jsonSchema.integer(s.PROTECTED_DESCRIPTOR_MIN, s.PROTECTED_DESCRIPTOR_MAX),
              passphraseFd: s.jsonSchema.integer(
                s.PROTECTED_DESCRIPTOR_MIN,
                s.PROTECTED_DESCRIPTOR_MAX,
              ),
            },
            ["name"],
          ),
          bindings: [
            s.positional("name", 0),
            s.option("provider"),
            s.option("stdin"),
            s.option("fd", undefined, s.stringify),
            s.option("passphraseFd", undefined, s.stringify),
          ],
          output: s.secretMutationOutput(),
        }),
      ),
      createSecretListCommandContract(
        defineContractMetadata({
          command: "secret.ls",
          catalogOrder: 10,
          mutability: "read",
          requiredFeatures: ["protected-secret-channel"],
          input: s.jsonSchema.object({
            passphraseFd: s.jsonSchema.integer(
              s.PROTECTED_DESCRIPTOR_MIN,
              s.PROTECTED_DESCRIPTOR_MAX,
            ),
          }),
          bindings: [s.option("passphraseFd", undefined, s.stringify)],
          output: s.dataObject(["names"], { names: s.stringArray }),
        }),
      ),
      createSecretRemoveCommandContract(
        defineContractMetadata({
          command: "secret.rm",
          catalogOrder: 11,
          mutability: "write",
          requiredFeatures: ["protected-secret-channel"],
          input: s.jsonSchema.object(
            {
              name: s.jsonSchema.string({ minLength: 1 }),
              provider: s.provider,
              passphraseFd: s.jsonSchema.integer(
                s.PROTECTED_DESCRIPTOR_MIN,
                s.PROTECTED_DESCRIPTOR_MAX,
              ),
            },
            ["name"],
          ),
          bindings: [
            s.positional("name", 0),
            s.option("provider"),
            s.option("passphraseFd", undefined, s.stringify),
          ],
          output: s.secretMutationOutput(),
        }),
      ),
      createOperationRecoverCommandContract(
        defineContractMetadata({
          command: "operation.recover",
          catalogOrder: 44,
          mutability: "write",
          requiredFeatures: ["mutation-authority", "plan-apply", "recovery"],
          input: s.jsonSchema.object(
            {
              operationId: s.jsonSchema.string({ minLength: 1 }),
              snapshotPassphraseFd: s.jsonSchema.integer(
                s.PROTECTED_DESCRIPTOR_MIN,
                s.PROTECTED_DESCRIPTOR_MAX,
              ),
              dryRun: s.jsonSchema.boolean(),
            },
            ["operationId"],
          ),
          bindings: [
            s.positional("operationId", 0),
            s.option("snapshotPassphraseFd", undefined, s.stringify),
            s.option("dryRun"),
          ],
          output: s.dataObject([], {
            diagnosis: s.mutationRecoveryDiagnosis,
            operation: s.presentedOperationResult,
          }),
        }),
      ),
    ],
  });
}
