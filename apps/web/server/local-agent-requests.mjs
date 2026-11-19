import { randomUUID } from "node:crypto";
import { boundedJson, demand, LIMITS } from "./local-agent-common.mjs";

function validateAnswers(schema, input) {
  const value = boundedJson(input, LIMITS.contextBytes);
  demand(value && typeof value === "object" && !Array.isArray(value), "invalid-answer", "回答必须是表单对象。");
  for (const key of schema?.required ?? []) demand(Object.hasOwn(value, key), "invalid-answer", "请填写所有必答项。");
  for (const [key, answer] of Object.entries(value)) {
    const rule = schema?.properties?.[key];
    demand(rule, "invalid-answer", "回答包含未知表单字段。");
    const itemOptions = rule?.items?.enum ?? rule?.items?.anyOf?.map(item => item.const);
    const scalarOptions = rule?.enum ?? rule?.oneOf?.map(item => item.const);
    const valid = rule.type === "array" ? Array.isArray(answer) && answer.every(item => typeof item === "string" && (!itemOptions || itemOptions.includes(item)))
      : rule.type === "integer" ? Number.isSafeInteger(answer) : typeof answer === rule.type;
    demand(valid && (!scalarOptions || scalarOptions.includes(answer)), "invalid-answer", "回答的类型或选项不符合表单要求。");
    if (typeof answer === "string") demand((rule.minLength === undefined || answer.length >= rule.minLength) && (rule.maxLength === undefined || answer.length <= rule.maxLength), "invalid-answer", "回答长度不符合表单要求。");
    if (typeof answer === "number") demand(Number.isFinite(answer) && (rule.minimum === undefined || answer >= rule.minimum) && (rule.maximum === undefined || answer <= rule.maximum), "invalid-answer", "回答数字超出表单范围。");
    if (Array.isArray(answer)) demand((!rule.uniqueItems || new Set(answer).size === answer.length) && (rule.minItems === undefined || answer.length >= rule.minItems) && (rule.maxItems === undefined || answer.length <= rule.maxItems), "invalid-answer", "所选项数不符合表单要求。");
  }
  return value;
}
export function createRequestCards({ emit, active, timeoutMs = LIMITS.permissionMs }) {
  const pending = new Map();
  function enqueue(type, params, signal) {
    const fallback = type === "permission" ? { outcome: { outcome: "cancelled" } } : { action: "cancel" };
    if (!active() || pending.size >= LIMITS.pending) return Promise.resolve(fallback);
    return new Promise(resolve => {
      const requestId = randomUUID(); let timer;
      const settle = result => { clearTimeout(timer); signal?.removeEventListener("abort", abort); pending.delete(requestId); resolve(result); };
      const abort = () => settle(fallback);
      if (signal?.aborted) return settle(fallback);
      pending.set(requestId, { type, params, settle, fallback });
      signal?.addEventListener("abort", abort, { once: true });
      timer = setTimeout(() => { emit({ type: "request-expired", requestId }); settle(fallback); }, timeoutMs);
      emit({ type: "request", requestType: type, requestId, ...(type === "permission" ? { options: params.options, toolCall: params.toolCall } : { message: params.message, requestedSchema: params.requestedSchema }) });
    });
  }
  return {
    permission(params, signal) { return enqueue("permission", params, signal); },
    elicitation(params, signal) {
      if (params.mode !== "form" || !params.requestedSchema) return Promise.resolve({ action: "decline" });
      return enqueue("question", params, signal);
    },
    answer({ requestId, optionId, answers }) {
      const request = pending.get(requestId);
      demand(request, "request-expired", "该请求已结束或取消，请刷新会话。");
      let result = request.fallback;
      if (request.type === "permission" && optionId !== undefined) {
        demand(request.params.options?.some(option => option.optionId === optionId && option.kind !== "allow_always"), "invalid-option", "请选择本次权限选项；不支持永久授权。");
        result = { outcome: { outcome: "selected", optionId } };
      } else if (request.type === "question" && answers !== undefined) result = { action: "accept", content: validateAnswers(request.params.requestedSchema, answers) };
      request.settle(result); emit({ type: "request-answered", requestId }); return { answered: true };
    },
    clear() { for (const request of [...pending.values()]) request.settle(request.fallback); },
  };
}
