import { nleAlphaIssues, parseNleProject } from "@glintai/scenescript";
import { nleRenderOptions } from "./nle-render-options.ts";
function parseRenderBody(body) {
  if (JSON.stringify(body?.project ?? {}).length > 300_000)
    throw new Error("NLE project is too large");
  const project = parseNleProject(body.project);
  if (body.alpha !== undefined && typeof body.alpha !== "boolean")
    throw new Error("透明导出选项必须为布尔值。");
  if (body.alpha === true) {
    const issues = nleAlphaIssues(project);
    if (issues.length)
      throw Object.assign(
        new Error(
          `透明导出不支持画面片段：${issues.map((issue) => `${issue.trackId}/${issue.clipId}`).join("、")}`,
        ),
        { issues },
      );
    if (project.width % 2 || project.height % 2)
      throw new Error("透明 WebM 的输出宽高必须为偶数。");
  }
  return {
    project,
    alpha: body.alpha === true,
    ...nleRenderOptions(project, body.motionSamples, body.shutterAngle),
  };
}
export async function handleNleRender(req, res, url, { renderer, assetFor, readBody, sendJson }) {
  if (req.method !== "POST" || url.pathname !== "/api/nle/render") return false;
  const controller = new AbortController();
  const stop = () => {
    if (!res.writableEnded) controller.abort();
  };
  res.once("close", stop);
  try {
    const body = JSON.parse(await readBody(req, controller.signal, 500_000));
    const options = parseRenderBody(body);
    sendJson(res, 200, await renderer({ ...options, assetFor, signal: controller.signal }));
  } catch (error) {
    sendJson(res, 400, {
      error: error instanceof Error ? error.message : "NLE render failed",
      ...(Array.isArray(error?.issues) ? { issues: error.issues } : {}),
    });
  } finally {
    res.off("close", stop);
  }
  return true;
}
