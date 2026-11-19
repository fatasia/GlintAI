import { createContext, useContext, type ReactNode } from "react";

const VisibleAuthoring = createContext(true);
export const useAuthoringVisible = () => useContext(VisibleAuthoring);

/** Retain editor state while disposing execution surfaces in any hidden ancestor pane. */
export function AuthoringVisibility({ active, children }: { active: boolean; children: ReactNode }) {
  const parent = useAuthoringVisible();
  return <VisibleAuthoring.Provider value={parent && active}>{children}</VisibleAuthoring.Provider>;
}
