import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { surveyCodeRepo } from "./code-repo";
export interface GraphNode {
  id: string;
  name: string;
  file: string;
  line: number;
  endLine: number;
  kind: "module" | "function";
}
export interface CodeGraph {
  version: 1;
  nodes: GraphNode[];
  edges: { from: string; to: string; line: number }[];
  unresolved: { file: string; line: number; expression: string }[];
  files: string[];
  scope: string;
}
/** TypeChecker-resolved calls in a bounded virtual TS/JS program. Never reads dependencies or executes code. */
export function analyzeCodeRepo(root: string): CodeGraph {
  const survey = surveyCodeRepo(root),
    repo = path.resolve(root);
  const files = survey.files
    .filter((f) => /\.[cm]?[jt]sx?$/.test(f.path))
    .map((f) => path.resolve(repo, f.path));
  const contents = new Map(
    files.map((file) => [file, fs.readFileSync(file, "utf8")]),
  );
  const options: ts.CompilerOptions = {
    allowJs: true,
    checkJs: true,
    noLib: true,
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    jsx: ts.JsxEmit.Preserve,
  };
  const key = (file: string) => path.resolve(file);
  const host: ts.CompilerHost = {
    getSourceFile: (file, language) =>
      contents.has(key(file))
        ? ts.createSourceFile(
            key(file),
            contents.get(key(file))!,
            language,
            true,
          )
        : undefined,
    getDefaultLibFileName: () => "",
    writeFile: () => {},
    getCurrentDirectory: () => repo,
    getDirectories: () => [],
    fileExists: (file) => contents.has(key(file)),
    readFile: (file) => contents.get(key(file)),
    getCanonicalFileName: (file) => key(file),
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    resolveModuleNames: (names, containing) =>
      names.map((name) => {
        if (!name.startsWith(".")) return undefined;
        const base = path.resolve(path.dirname(containing), name),
          choices = [
            base,
            ...[".ts", ".tsx", ".js", ".jsx", ".mjs"].map((ext) => base + ext),
            ...["index.ts", "index.tsx", "index.js"].map((f) =>
              path.join(base, f),
            ),
            base.replace(/\.js$/, ".ts"),
          ];
        const found = choices.find((f) => contents.has(f));
        return found ? { resolvedFileName: found } : undefined;
      }),
  };
  const program = ts.createProgram(files, options, host),
    checker = program.getTypeChecker();
  const graph: CodeGraph = {
    version: 1,
    nodes: [],
    edges: [],
    unresolved: [],
    files: files.map((f) => path.relative(repo, f).replace(/\\/g, "/")),
    scope:
      "At most 12 surveyed TS/JS files; statically resolved calls only. Dynamic dispatch, runtime coverage and external dependencies are not inferred.",
  };
  const ids = new Map<ts.Node, string>(),
    modules = new Map<ts.SourceFile, string>();
  const line = (n: ts.Node) =>
    n.getSourceFile().getLineAndCharacterOfPosition(n.getStart()).line + 1;
  const add = (node: ts.Node, name: string, kind: GraphNode["kind"]) => {
    const source = node.getSourceFile(),
      file = path.relative(repo, source.fileName).replace(/\\/g, "/"),
      id = `${file}:${kind}:${node.pos}`;
    graph.nodes.push({
      id,
      name,
      file,
      line: kind === "module" ? 1 : line(node),
      endLine: source.getLineAndCharacterOfPosition(node.end).line + 1,
      kind,
    });
    ids.set(node, id);
    return id;
  };
  for (const source of program.getSourceFiles()) {
    modules.set(source, add(source, path.basename(source.fileName), "module"));
    const visit = (node: ts.Node) => {
      if (
        ts.isFunctionDeclaration(node) ||
        ts.isFunctionExpression(node) ||
        ts.isArrowFunction(node) ||
        ts.isMethodDeclaration(node) ||
        ts.isConstructorDeclaration(node)
      ) {
        const named = node as ts.NamedDeclaration;
        const name =
          named.name?.getText() ??
          (ts.isVariableDeclaration(node.parent)
            ? node.parent.name.getText()
            : ts.isConstructorDeclaration(node)
              ? "constructor"
              : `anonymous@${line(node)}`);
        add(node, name, "function");
      }
      ts.forEachChild(node, visit);
    };
    ts.forEachChild(source, visit);
  }
  for (const source of program.getSourceFiles()) {
    const visit = (node: ts.Node, owner: string) => {
      owner = ids.get(node) ?? owner;
      if (ts.isCallExpression(node) || ts.isNewExpression(node)) {
        const declaration = checker.getResolvedSignature(node)?.declaration,
          to = declaration && ids.get(declaration);
        if (to) graph.edges.push({ from: owner, to, line: line(node) });
        else if (graph.unresolved.length < 1000)
          graph.unresolved.push({
            file: path.relative(repo, source.fileName).replace(/\\/g, "/"),
            line: line(node),
            expression: node.expression.getText().slice(0, 200),
          });
      }
      ts.forEachChild(node, (child) => visit(child, owner));
    };
    visit(source, modules.get(source)!);
  }
  return graph;
}
