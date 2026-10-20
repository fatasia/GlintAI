import fs from "node:fs";
import path from "node:path";
const CHECKS = {
  entropy: [
    { id: "isolated", sceneId: "second-law", concept: "适用条件", question: "熵不减少的条件是什么？", choices: ["任意系统", "孤立系统", "有生命的系统"], answer: 1, explanation: "资料将热力学第二定律的适用对象限定为孤立系统。", source: "熵与生命：热力学第二定律" },
    { id: "life", sceneId: "life", concept: "开放系统", question: "生命的局部有序为什么不直接违反熵增原理？", choices: ["生命不受物理规律约束", "生命是开放系统，会与环境交换能量和物质", "生命让整个宇宙的熵减少"], answer: 1, explanation: "局部有序与环境的熵变化要一起考虑；生命不是孤立系统。", source: "熵与生命：生命" },
  ],
  uncertainty: [
    { id: "uncertainty", sceneId: "intro", concept: "不确定性", question: "位置和动量的不确定性描述什么？", choices: ["仪器精度差造成、可无限消除的误差", "量子态的位置与动量分布存在联合约束", "粒子没有动量"], answer: 1, explanation: "不确定关系针对量子态的分布，不只是仪器误差。", source: "Uncertainty Principle：source.md" },
  ],
};
/** Explicit authored checks; scores describe these questions, not a proof of understanding. */
export function createCheckStore(directory) {
  fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, "checks.jsonl");
  let attempts = [];
  try {
    if (fs.statSync(file).size <= 4 * 1024 * 1024) attempts = fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } }).slice(-1000);
  } catch { /* No previous answers. */ }
  const persist = () => {
    const temp = `${file}.tmp`; fs.writeFileSync(temp, attempts.map((entry) => JSON.stringify(entry)).join("\n") + "\n"); fs.renameSync(temp, file);
  };
  return {
    questions(project) {
      const questions = Object.hasOwn(CHECKS, project) && CHECKS[project];
      return questions ? questions.map(({ answer, explanation, ...question }) => question) : null;
    },
    submit(project, input) {
      const questions = Object.hasOwn(CHECKS, project) && CHECKS[project];
      if (!questions) throw new Error("Unknown project");
      if (!input || typeof input.attemptId !== "string" || !/^[a-zA-Z0-9-]{8,80}$/.test(input.attemptId) || !Array.isArray(input.answers) || input.answers.length !== questions.length) throw new Error("Invalid answers");
      const previous = attempts.find((entry) => entry.project === project && entry.attemptId === input.attemptId);
      if (previous) return previous.result;
      const seen = new Set();
      const results = input.answers.map(({ id, choice }) => {
        const question = questions.find((entry) => entry.id === id);
        if (!question || seen.has(id) || !Number.isInteger(choice) || choice < 0 || choice >= question.choices.length) throw new Error("Invalid choice");
        seen.add(id);
        return { id, concept: question.concept, correct: choice === question.answer, answer: question.answer, explanation: question.explanation, source: question.source };
      });
      const result = { correct: results.filter((entry) => entry.correct).length, total: questions.length, results };
      attempts.push({ project, attemptId: input.attemptId, result, at: Date.now() }); attempts = attempts.slice(-1000); persist();
      return result;
    },
    stats(project) {
      if (!Object.hasOwn(CHECKS, project)) return null;
      const records = attempts.filter((entry) => entry.project === project);
      const concepts = CHECKS[project].map((question) => {
        const answers = records.flatMap((entry) => entry.result?.results ?? []).filter((entry) => entry.id === question.id);
        return { concept: question.concept, answered: answers.length, missed: answers.filter((entry) => !entry.correct).length };
      });
      return { attempts: records.length, concepts, basis: "本机最近 1000 条作答记录；重复作答计入次数，不代表独立观众或理解度证明。" };
    },
  };
}
