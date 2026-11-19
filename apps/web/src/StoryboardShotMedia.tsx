import { useEffect, useState } from "react";
import type { Scene } from "@glintai/scenescript";
import type { Series } from "@glintai/composer/drama-series";
import { libraryVisual, type LibraryVisual } from "./media-adoption";
import { storyboardVideoPrompt, type StoryboardShot } from "./storyboard-project";
import { StoryboardVideo } from "./StoryboardVideo";
import {
  storyboardDependencyDigest,
  storyboardGenerationInput,
} from "./storyboard-shot-dependency";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
type Props = {
  row: StoryboardShot;
  series: Series;
  projectId: string;
  current?: Scene;
  assets: LibraryVisual[];
  selected?: string;
  loading: boolean;
  disabled: boolean;
  onSelect(name: string): void;
  onApply(): void;
};
function useDependency(series: Series, row: StoryboardShot) {
  const input = JSON.stringify(storyboardGenerationInput(series, row));
  const [result, setResult] = useState<{ input: string; digest: string }>({
    input: "",
    digest: "",
  });
  useEffect(() => {
    let current = true;
    void storyboardDependencyDigest(JSON.parse(input))
      .then((digest) => {
        if (current) setResult({ input, digest });
      })
      .catch(() => {
        if (current) setResult({ input, digest: "error" });
      });
    return () => {
      current = false;
    };
  }, [input]);
  return result.input === input ? result.digest : "";
}
export function StoryboardShotMedia(props: Props) {
  const { row, current, selected, assets, disabled, loading } = props;
  const name =
    current && (current.kind === "video" || current.kind === "image") ? current.src.slice(7) : "";
  const pending = selected !== undefined && selected !== name;
  const label = t("storyboard.mediaFor", { scene: row.scene.heading, shot: row.shot.index });
  const locked = disabled || Boolean(current?.locked);
  const dependency = useDependency(props.series, row);
  return (
    <div>
      <p className="ws-note">
        {t(
          pending
            ? "storyboard.pendingMedia"
            : current
              ? "storyboard.applied"
              : "storyboard.unapplied",
        )}
      </p>
      <label>
        {label}
        <select
          aria-label={label}
          value={selected ?? name}
          disabled={loading || locked}
          onChange={(event) => props.onSelect(event.target.value)}
        >
          <option value="">{t("storyboard.chooseMedia")}</option>
          {name && !assets.some((asset) => asset.name === name) && <option>{name}</option>}
          {assets.map((asset) => (
            <option key={asset.name}>{asset.name}</option>
          ))}
        </select>
      </label>
      <StoryboardVideo
        key={dependency}
        identity={`${encodeURIComponent(props.projectId)}:${row.id}:${dependency}`}
        prompt={storyboardVideoPrompt(row)}
        disabled={locked || !dependency || dependency === "error"}
        onSelect={(name) => {
          libraryVisual(name);
          props.onSelect(name);
        }}
      />
      {dependency === "error" && <p className="ws-note">{t("storyboard.digestUnavailable")}</p>}
      <Button
        size="sm"
        disabled={loading || locked || !current || !(selected ?? name)}
        onClick={props.onApply}
      >
        {t("storyboard.replaceOne")}
      </Button>
    </div>
  );
}
