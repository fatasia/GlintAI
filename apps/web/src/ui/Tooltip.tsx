import * as RadixTooltip from "@radix-ui/react-tooltip";
import type { ReactNode } from "react";

/**
 * Hover/focus hint for rich content inside editors. The trigger keeps its own accessible
 * name; the tooltip only adds detail. Self-contained (own provider) so it can live in lazy
 * chunks without an app-level provider pulling Radix into the first screen.
 */
export function Tooltip({ content, side = "top", children }: { content: ReactNode; side?: "top" | "right" | "bottom" | "left"; children: ReactNode }) {
  return <RadixTooltip.Provider delayDuration={450} skipDelayDuration={250}>
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className="g-tooltip" side={side} sideOffset={8} collisionPadding={8}>{content}</RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  </RadixTooltip.Provider>;
}
