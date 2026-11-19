import { useId, useState, type ReactNode } from "react";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
import "./timeline-dock.css";

type Props = {
  storageKey: string;
  label: string;
  summary?: string;
  children: ReactNode;
};

const preferenceKey = (key: string) => `glint.timeline-dock.v1:${key}`;

function readCollapsed(key: string): boolean {
  try {
    return localStorage.getItem(preferenceKey(key)) === "collapsed";
  } catch {
    return false;
  }
}

export function TimelineDock(props: Props) {
  return <DockState key={props.storageKey} {...props} />;
}

function DockState({ storageKey, label, summary, children }: Props) {
  const [collapsed, setCollapsed] = useState(() => readCollapsed(storageKey));
  const bodyId = useId();
  const toggle = () => {
    const next = !collapsed;
    setCollapsed(next);
    try {
      localStorage.setItem(preferenceKey(storageKey), next ? "collapsed" : "expanded");
    } catch {
      // A blocked preference store must not prevent editing.
    }
  };
  return (
    <section className="timeline-dock" aria-label={label} data-collapsed={collapsed}>
      <header className="timeline-dock__bar">
        <strong>{label}</strong>
        {summary && <span className="timeline-dock__summary">{summary}</span>}
        <Button
          size="sm"
          variant="ghost"
          className="timeline-dock__toggle"
          aria-controls={bodyId}
          aria-expanded={!collapsed}
          onClick={toggle}
        >
          <span aria-hidden="true">{collapsed ? "⌃" : "⌄"}</span>
          {t(collapsed ? "timelineDock.expand" : "timelineDock.collapse")}
        </Button>
      </header>
      <div id={bodyId} className="timeline-dock__body" hidden={collapsed}>
        {children}
      </div>
    </section>
  );
}
