export interface PaletteCommand {
  id: string;
  label: string;
  /** Section the command is listed under, e.g. "前往", "工程". */
  group: string;
  /** Extra search words (not shown). */
  keywords?: string;
  hint?: string;
  run(): void;
}

const normalize = (value: string) => value.toLocaleLowerCase().normalize("NFKC");

/**
 * Every whitespace-separated term must appear in the label, group or keywords.
 * Label hits rank above keyword-only hits; earlier hits rank above later ones; ties keep input order.
 */
export function filterCommands(commands: readonly PaletteCommand[], query: string): PaletteCommand[] {
  const terms = normalize(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return [...commands];
  const scored: { command: PaletteCommand; score: number; order: number }[] = [];
  commands.forEach((command, order) => {
    const label = normalize(command.label), rest = normalize(`${command.group} ${command.keywords ?? ""}`);
    let score = 0;
    for (const term of terms) {
      const inLabel = label.indexOf(term);
      if (inLabel >= 0) { score += inLabel; continue; }
      const inRest = rest.indexOf(term);
      if (inRest < 0) return;
      score += 100 + inRest;
    }
    scored.push({ command, score, order });
  });
  return scored.sort((a, b) => a.score - b.score || a.order - b.order).map(item => item.command);
}

/** Group commands for display while keeping the filtered order inside and between groups. */
export function groupCommands(commands: readonly PaletteCommand[]): { group: string; items: PaletteCommand[] }[] {
  const groups: { group: string; items: PaletteCommand[] }[] = [];
  for (const command of commands) {
    const existing = groups.find(item => item.group === command.group);
    if (existing) existing.items.push(command); else groups.push({ group: command.group, items: [command] });
  }
  return groups;
}
