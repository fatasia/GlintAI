import * as Dialog from "@radix-ui/react-dialog";
import { useEffect, useMemo, useRef, useState } from "react";
import { t } from "../ui/i18n";
import { Icon } from "../ui/icons";
import { filterCommands, groupCommands, type PaletteCommand } from "./command-filter";

/** Loaded on first open, so the dialog runtime stays out of the first screen. */
export default function CommandPalette({ commands, onClose }: { commands: readonly PaletteCommand[]; onClose(): void }) {
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const matches = useMemo(() => filterCommands(commands, query), [commands, query]);
  const groups = useMemo(() => groupCommands(matches), [matches]);
  // Flatten in display order so the arrow keys follow what the user sees.
  const ordered = useMemo(() => groups.flatMap(group => group.items), [groups]);
  const current = Math.min(active, Math.max(ordered.length - 1, 0));

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => { list.current?.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView?.({ block: "nearest" }); }, [current, ordered]);

  const run = (command: PaletteCommand | undefined) => {
    if (!command) return;
    onClose();
    // Let the dialog release focus and scroll lock before the command moves the app.
    queueMicrotask(() => command.run());
  };

  return <Dialog.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Overlay className="g-overlay" />
      <Dialog.Content className="g-palette" aria-describedby={undefined}
        onKeyDown={event => {
          // Enter that confirms an IME candidate must not run a command.
          if (event.nativeEvent.isComposing || event.keyCode === 229) return;
          if (event.key === "ArrowDown") { event.preventDefault(); setActive(ordered.length ? (current + 1) % ordered.length : 0); }
          else if (event.key === "ArrowUp") { event.preventDefault(); setActive(ordered.length ? (current + ordered.length - 1) % ordered.length : 0); }
          else if (event.key === "Home") { event.preventDefault(); setActive(0); }
          else if (event.key === "End") { event.preventDefault(); setActive(Math.max(ordered.length - 1, 0)); }
          else if (event.key === "Enter") { event.preventDefault(); run(ordered[current]); }
        }}>
        <Dialog.Title className="g-visually-hidden">{t("palette.title")}</Dialog.Title>
        <div className="g-palette-search">
          <Icon name="MagnifyingGlass" size={18} />
          <input autoFocus role="combobox" aria-expanded="true" aria-controls="g-palette-list" aria-autocomplete="list"
            aria-activedescendant={ordered[current] ? `g-palette-${ordered[current].id}` : undefined}
            aria-label={t("palette.title")} placeholder={t("palette.placeholder")} value={query} onChange={event => setQuery(event.target.value)} />
        </div>
        <div className="g-palette-list" id="g-palette-list" role="listbox" aria-label={t("palette.results")} ref={list}>
          {ordered.length === 0 && <p className="g-palette-empty" role="status">{t("palette.empty")}</p>}
          {groups.map(group => <div key={group.group} role="group" aria-label={group.group}>
            <div className="g-palette-group" aria-hidden="true">{group.group}</div>
            {group.items.map(command => <div key={command.id} id={`g-palette-${command.id}`} role="option" className="g-palette-item"
              aria-selected={ordered[current]?.id === command.id}
              onMouseMove={() => { const index = ordered.indexOf(command); if (index !== current) setActive(index); }}
              onClick={() => run(command)}>
              <span>{command.label}</span>{command.hint && <kbd>{command.hint}</kbd>}
            </div>)}
          </div>)}
        </div>
        <div className="g-palette-foot" aria-hidden="true"><span><kbd>↑</kbd><kbd>↓</kbd> {t("palette.move")}</span><span><kbd>Enter</kbd> {t("palette.run")}</span><span><kbd>Esc</kbd> {t("palette.close")}</span></div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
