import { LocalAssetPath } from "@glintai/scenescript";
import { createContext, useContext, type ReactNode } from "react";
import { staticFile } from "remotion";

export type MediaAssetBase = "/api/media/assets/";

const MediaAssetContext = createContext<MediaAssetBase | undefined>(undefined);
const LIBRARY_ASSET = /^assets\/([a-zA-Z0-9_-]{1,100}\.(?:png|jpg|webp|mp4))$/;

/** Resolve at presentation time only; SceneScript always retains its portable local path. */
export function resolveMediaAssetSrc(src: string, mediaAssetBase?: MediaAssetBase): string {
  const localSrc = LocalAssetPath.parse(src);
  const libraryAsset = LIBRARY_ASSET.exec(localSrc);
  if (mediaAssetBase === "/api/media/assets/" && libraryAsset) {
    return `${mediaAssetBase}${encodeURIComponent(libraryAsset[1]!)}`;
  }
  return staticFile(localSrc);
}

export function MediaAssetProvider({ mediaAssetBase, children }: {
  mediaAssetBase?: MediaAssetBase;
  children: ReactNode;
}) {
  return <MediaAssetContext.Provider value={mediaAssetBase}>{children}</MediaAssetContext.Provider>;
}

export function useMediaAssetSrc(src: string): string {
  return resolveMediaAssetSrc(src, useContext(MediaAssetContext));
}
