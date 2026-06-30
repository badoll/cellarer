// rules 编解码:markdown concat 形态(复用 markers 渲染)。
// 所有当前 agent 的 rules 都是 markdown concat,故共用一个 codec 实例。

import { isGenerated, renderRules } from "../markers.js";
import type { RulesCodec } from "./types.js";

export const markdownRulesCodec: RulesCodec = {
  render: (fragments) => renderRules(fragments),
  isGenerated: (content) => isGenerated(content),
};
