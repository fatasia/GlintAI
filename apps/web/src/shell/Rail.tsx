import { lazy, Suspense, useRef, useState } from "react";
import { t, type MessageId } from "../ui/i18n";
import { Icon, type IconName } from "../ui/icons";
import type { RailArea } from "./routes";

const HelpPopover = lazy(() => import("./HelpPopover"));

export type Theme = "dark" | "light";

interface RailProps {
  active?: RailArea;
  theme: Theme;
  localDownload: boolean;
  onHome(): void;
  onArea(area: RailArea): void;
  onTheme(theme: Theme): void;
  onSearch(): void;
}

const PRIMARY: { area: RailArea; label: MessageId; hint: MessageId; icon: IconName }[] = [
  { area: "studio", label: "nav.project", hint: "nav.project.hint", icon: "FolderSimple" },
  { area: "library", label: "nav.library", hint: "nav.library.hint", icon: "ImagesSquare" },
  { area: "automation", label: "nav.automation", hint: "nav.automation.hint", icon: "FlowArrow" },
];

// Hints are a CSS hover label (data-hint): the visible text already names the button,
// so the hint adds detail without a tooltip runtime on the first screen.
function RailButton({ area, label, hint, icon, active, onArea }: { area: RailArea; label: MessageId; hint: MessageId; icon: IconName; active?: RailArea; onArea(area: RailArea): void }) {
  const current = active === area;
  return <button type="button" className="rail-button" aria-label={t(label)} data-hint={t(hint)} aria-current={current ? "page" : undefined} onClick={() => onArea(area)}>
    <Icon name={icon} weight={current ? "fill" : "regular"} /><span>{t(label)}</span>
  </button>;
}

export function Rail({ active, theme, localDownload, onHome, onArea, onTheme, onSearch }: RailProps) {
  const helpButton = useRef<HTMLButtonElement>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  return <aside className="app-rail" aria-label={t("nav.rail")}>
    <button type="button" className="rail-brand" aria-label={t("nav.home")} onClick={onHome}>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l2.35 6.65L21 11.5l-6.65 2.35L12 20.5l-2.35-6.65L3 11.5l6.65-2.35z" /></svg>
    </button>
    <button type="button" className="rail-button rail-search" aria-label={t("nav.search")} aria-keyshortcuts="Control+K Meta+K" data-hint={`${t("nav.search.hint")} · Ctrl K`} onClick={onSearch}>
      <Icon name="MagnifyingGlass" /><span>{t("nav.search")}</span>
    </button>
    <nav className="rail-group" aria-label={t("nav.main")}>
      {PRIMARY.map(item => <RailButton key={item.area} {...item} active={active} onArea={onArea} />)}
    </nav>
    <div className="rail-group rail-group--tools">
      <RailButton area="edit" label="nav.edit" hint="nav.edit.hint" icon="FilmSlate" active={active} onArea={onArea} />
    </div>
    <div className="rail-group rail-group--end">
      <button ref={helpButton} type="button" className="rail-button" aria-label={t("nav.help")} data-hint={`${t("help.docs")} · ${t("help.appearance")}`}
        aria-haspopup="dialog" aria-expanded={helpOpen} data-state={helpOpen ? "open" : "closed"} onClick={() => setHelpOpen(open => !open)}>
        <Icon name="Question" weight={helpOpen ? "fill" : "regular"} /><span>{t("nav.help")}</span>
      </button>
      {helpOpen && <Suspense fallback={null}>
        <HelpPopover anchor={helpButton} theme={theme} localDownload={localDownload} onTheme={onTheme} onClose={() => setHelpOpen(false)} />
      </Suspense>}
      <RailButton area="settings" label="nav.settings" hint="nav.settings.hint" icon="GearSix" active={active} onArea={onArea} />
    </div>
  </aside>;
}
