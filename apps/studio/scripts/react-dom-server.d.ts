// Minimal ambient typing for react-dom/server: the studio workspace lacks
// @types/react-dom, and only renderToStaticMarkup is consumed (HTML fixtures).
declare module "react-dom/server" {
  export function renderToStaticMarkup(node: unknown): string;
}
