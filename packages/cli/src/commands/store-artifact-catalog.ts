import {
  type CommandDomain,
  defineCommandDomain,
  defineContractMetadata,
} from "../protocol/command-contract.js";
import { commandSchemaFragments as s } from "../protocol/command-schema-fragments.js";
import { createAddCommandContract } from "./add.js";
import { createLsCommandContract } from "./ls.js";

export function createStoreArtifactDomain(): CommandDomain {
  return defineCommandDomain({
    id: "store-artifacts",
    contracts: [
      createAddCommandContract(
        defineContractMetadata({
          command: "add",
          catalogOrder: 1,
          mutability: "write",
          requiredFeatures: ["mutation-authority"],
          input: s.jsonSchema.object(
            {
              source: s.jsonSchema.string({ minLength: 1 }),
              force: s.jsonSchema.boolean(),
              list: s.jsonSchema.boolean(),
              skills: s.stringArray,
              all: s.jsonSchema.boolean(),
              collection: s.jsonSchema.string({ minLength: 1 }),
              yes: s.jsonSchema.boolean(),
              secretMode: s.secretMode,
              vaultPassphraseFd: s.jsonSchema.integer(
                s.PROTECTED_DESCRIPTOR_MIN,
                s.PROTECTED_DESCRIPTOR_MAX,
              ),
              keychainService: s.jsonSchema.string({ minLength: 1 }),
            },
            ["source"],
          ),
          bindings: [
            s.positional("source", 0),
            s.option("force"),
            s.option("list"),
            s.option("skills", "skill"),
            s.option("all"),
            s.option("collection"),
            s.option("yes"),
            s.option("secretMode"),
            s.option("vaultPassphraseFd", undefined, s.stringify),
            s.option("keychainService"),
          ],
          output: s.dataObject(["imported", "skipped", "rejected", "candidates"], {
            imported: s.jsonSchema.array(s.importedArtifact),
            skipped: s.jsonSchema.array(s.rejectedArtifact),
            rejected: s.jsonSchema.array(s.rejectedArtifact),
            candidates: s.jsonSchema.array(s.skillCandidate),
            operation: s.presentedOperationResult,
          }),
        }),
      ),
      createLsCommandContract(
        defineContractMetadata({
          command: "ls",
          catalogOrder: 3,
          mutability: "read",
          input: s.jsonSchema.object({
            collection: s.jsonSchema.string({ minLength: 1 }),
          }),
          bindings: [s.option("collection")],
          output: s.dataObject(["artifacts", "storeEmpty"], {
            artifacts: s.artifactArray,
            storeEmpty: s.jsonSchema.boolean(),
          }),
        }),
      ),
    ],
  });
}
