import { renderRules } from "../markers.js";
import type { RulesCodec } from "./types.js";

/** @deprecated Rules use the single built-in markdown renderer during execution. */
export const markdownRulesCodec: RulesCodec = {
  render: (fragments) => renderRules(fragments),
};
