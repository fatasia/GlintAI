import { spawn } from "node:child_process";
import path from "node:path";
import { stopOwnedProcess } from "./local-agent-process.mjs";
import { demand, exists, LIMITS, ProjectGitError, readText } from "./project-git-files.mjs";

export const OWN_CONFIG = "[core]\n\trepositoryformatversion = 0\n\tbare = false\n\tlogallrefupdates = true\n\tfilemode = false\n\tignorecase = false\n\tautocrlf = false\n\tsymlinks = false\n";
function environment() {
  const names = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "WINDIR", "TEMP", "TMP"];
  const env = Object.fromEntries(names.filter(key => typeof process.env[key] === "string").map(key => [key, process.env[key]]));
  return { ...env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_REPLACE_OBJECTS: "1",
    GIT_ATTR_NOSYSTEM: "1", GIT_LFS_SKIP_SMUDGE: "1", GIT_AUTHOR_NAME: "Glint Local", GIT_AUTHOR_EMAIL: "local@glint.invalid",
    GIT_COMMITTER_NAME: "Glint Local", GIT_COMMITTER_EMAIL: "local@glint.invalid", LC_ALL: "C", LANG: "C" };
}
export function createGitProcess(gitPath = "git") {
  demand(typeof gitPath === "string" && gitPath.length > 0 && !/[\0\r\n]/.test(gitPath), "invalid-git", "Git 程序路径无效。");
  const ownProcess = new Set();
  let disposed = false;
  return {
    async run(root, args, { input, initialize = false, allowMissing = false } = {}) {
      demand(!disposed, "disposed", "版本服务已关闭，请重新打开工程。");
      const gitDir = path.join(root, "repo.git"), empty = path.join(root, "empty"), nullFile = process.platform === "win32" ? "NUL" : "/dev/null";
      if (!initialize) {
        demand(await readText(path.join(gitDir, "config"), 4096) === OWN_CONFIG, "unsafe-repository", "版本库配置已被外部修改，已停止操作以保护工程。");
        for (const file of ["commondir", "config.worktree", "objects/info/alternates", "info/grafts"])
          demand(!await exists(path.join(gitDir, file)), "unsafe-repository", "版本库含外部配置或对象引用，已停止操作。");
      }
      const options = ["-c", `core.hooksPath=${empty}`, "-c", "core.fsmonitor=false", "-c", `core.attributesFile=${nullFile}`,
        "-c", `core.excludesFile=${nullFile}`, "-c", "core.autocrlf=false", "-c", "core.untrackedCache=false",
        "-c", "commit.gpgsign=false", "-c", "protocol.allow=never", "-c", "diff.external=", "--no-pager"];
      if (!initialize) options.push(`--git-dir=${gitDir}`, `--work-tree=${path.join(root, "work")}`);
      return new Promise((resolve, reject) => {
        let child, timer, ended = false, size = 0, output = [], failure;
        const finish = (error, value) => {
          if (ended) return; ended = true; clearTimeout(timer); ownProcess.delete(child);
          if (error) reject(error); else resolve(value);
        };
        const stop = error => { failure ??= error; void stopOwnedProcess(child).then(() => finish(failure)); };
        try {
          child = spawn(gitPath, [...options, ...args], { cwd: root, env: environment(), shell: false,
            windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
          ownProcess.add(child);
          child.on("error", error => finish(new ProjectGitError(error.code === "ENOENT" ? "git-missing" : "git-start",
            error.code === "ENOENT" ? "未找到 Git。请安装 Git 并重启 Glint，或配置 Git 程序路径。" : "无法启动 Git，请检查程序路径和执行权限。")));
          child.stdout.on("data", chunk => {
            size += chunk.length;
            if (size > LIMITS.output) stop(new ProjectGitError("too-large", "版本内容过大，请缩小查询范围。")); else output.push(chunk);
          });
          child.stderr.on("data", chunk => { size += chunk.length; if (size > LIMITS.output) stop(new ProjectGitError("too-large", "Git 返回数据过多，已取消操作。")); });
          child.stdin.on("error", () => { /* the close/error event reports a failed Git process */ });
          child.once("close", code => finish(failure ?? (disposed ? new ProjectGitError("disposed", "版本服务已关闭，操作已取消。")
            : code === 0 || allowMissing && code === 128 ? undefined : new ProjectGitError("git-failed", "Git 操作失败，请检查本地磁盘空间和工程数据目录权限后重试。")), Buffer.concat(output).toString("utf8")));
          timer = setTimeout(() => stop(new ProjectGitError("git-timeout", "Git 响应超时，操作已取消，请稍后重试。")), LIMITS.processMs);
          child.stdin.end(input ?? "");
        } catch { finish(new ProjectGitError("git-start", "无法启动 Git，请检查程序路径和执行权限。")); }
      });
    },
    async dispose() {
      disposed = true;
      await Promise.all([...ownProcess].map(child => stopOwnedProcess(child)));
    },
  };
}
