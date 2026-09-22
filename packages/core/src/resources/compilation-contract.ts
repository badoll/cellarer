import { loadCompatibility } from "../adapters/compatibility.js";
import type { Env } from "../env.js";
import { canonicalJson } from "../protocol/canonical.js";
import { sha256 } from "../store/checksum.js";
import { packagedConfigText } from "../store/config.js";
import { RESOURCE_SEMANTICS_VERSION } from "./semantics.js";

/** Packaged adapters are not covered by the user's Store configuration fingerprint. */
export async function compilationContract(
  env: Env,
): Promise<{ version: string; adapterFingerprint: string }> {
  const [configuration, compatibility] = await Promise.all([
    packagedConfigText(env),
    loadCompatibility(env),
  ]);
  return {
    version: RESOURCE_SEMANTICS_VERSION,
    adapterFingerprint: sha256(canonicalJson({ configuration, compatibility })),
  };
}
