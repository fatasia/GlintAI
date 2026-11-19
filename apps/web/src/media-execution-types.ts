import type { VideoSelection } from "./media-work-start";
import type { ExecutionTask } from "./media-execution-client";
export type MediaExecutionProps = {
  storageKey: string;
  initialPrompt?: string;
  initialPayload?: Record<string, unknown>;
  initialType?: "image" | "video" | "audio";
  onUseMedia?(task: ExecutionTask): Promise<void>;
  useMediaLabel?: string;
  disabled?: boolean;
  onBusyChange?(busy: boolean): void;
  onUseVideo?(asset: VideoSelection): Promise<void>;
  useVideoLabel?: string;
};
