import { createRoot } from "react-dom/client";
import "@fontsource-variable/geist";
import "@fontsource-variable/geist-mono";
import { App } from "./App";
import "./app-theme.css";
import "./ui-system.css";
// Tokens load last so their values win over the legacy theme files.
import "./ui/tokens.css";
import "./ui/base.css";
import "./ui/primitives.css";
import { recoverLegacyImport } from "./legacy-recovery";

const root = createRoot(document.getElementById("root")!);
let startupError = "";
try { recoverLegacyImport(localStorage); } catch (error) { startupError = error instanceof Error ? error.message : "无法读取恢复日志。"; }
if (startupError || window.location.hash === "#/recovery") {
  void import("./LegacyRecovery").then(({default: Recovery}) => root.render(<Recovery startupError={startupError}/>));
} else root.render(<App />);
