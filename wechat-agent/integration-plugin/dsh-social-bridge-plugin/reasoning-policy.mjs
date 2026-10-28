/**
 * 社交轮次的推理预算策略（设计文档 S8）。
 *
 * 闲聊不需要最强推理档：高推理档的思考 token 按输出计费，会在每条消息上重复收费。
 * 这里只做纯计算，方便离线测试；真正读取模型目录由 native-context.mjs 负责。
 */
export const SOCIAL_MAX_OUTPUT_TOKENS = 4096;

/** 从模型公布的推理档位里选出最便宜的一档；没有公布任何档位时返回 null。 */
export function pickLowestEffort(efforts) {
  const list = Array.isArray(efforts) ? efforts.filter((item) => typeof item?.id === 'string' && item.id) : [];
  // The catalog order is presentation order, not cost order: rank explicitly.
  for (const cheapest of [/^(off|none|disabled)$/i, /^(minimal|min)$/i, /^(low|lowest)$/i]) {
    const hit = list.find((item) => cheapest.test(item.id));
    if (hit) return hit.id;
  }
  return list[0]?.id ?? null;
}
