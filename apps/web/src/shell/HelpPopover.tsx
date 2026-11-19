import * as Popover from "@radix-ui/react-popover";
import type { RefObject } from "react";
import { applicationUrl } from "../app-url";
import { t } from "../ui/i18n";
import { Icon } from "../ui/icons";
import type { Theme } from "./Rail";

interface HelpPopoverProps {
  anchor: RefObject<HTMLButtonElement | null>;
  theme: Theme;
  localDownload: boolean;
  onTheme(theme: Theme): void;
  onClose(): void;
}

/** Loaded on first open so the popover positioning code stays out of the first screen. */
export default function HelpPopover({ anchor, theme, localDownload, onTheme, onClose }: HelpPopoverProps) {
  return <Popover.Root open onOpenChange={open => { if (!open) onClose(); }}>
    <Popover.Anchor virtualRef={anchor as RefObject<HTMLButtonElement>} />
    <Popover.Portal>
      <Popover.Content className="g-popover rail-help" side="right" align="end" sideOffset={10} collisionPadding={12}
        // The trigger toggles the popover itself; treating its press as "outside" would reopen it.
        onInteractOutside={event => { if (anchor.current?.contains(event.target as Node)) event.preventDefault(); }}
        onCloseAutoFocus={event => { event.preventDefault(); anchor.current?.focus(); }}>
        <nav aria-label={t("help.links")} className="rail-help-links">
          <a href="#/docs" onClick={onClose}><Icon name="BookOpen" size={16} />{t("help.docs")}</a>
          <a href="https://github.com/fatasia/GlintAI" target="_blank" rel="noreferrer"><Icon name="GithubLogo" size={16} />{t("help.source")}</a>
          <a href={applicationUrl(localDownload ? "/api/download/client" : "https://github.com/fatasia/GlintAI/releases")} {...(localDownload ? { download: true } : { target: "_blank", rel: "noreferrer" })}><Icon name="DownloadSimple" size={16} />{t("help.download")}</a>
        </nav>
        <div className="rail-help-theme" role="group" aria-label={t("help.appearance")}>
          <span>{t("help.appearance")}</span>
          <div className="g-segmented">
            <button type="button" aria-pressed={theme === "dark"} aria-label={t("theme.toDark")} onClick={() => onTheme("dark")}>{t("theme.dark")}</button>
            <button type="button" aria-pressed={theme === "light"} aria-label={t("theme.toLight")} onClick={() => onTheme("light")}>{t("theme.light")}</button>
          </div>
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
