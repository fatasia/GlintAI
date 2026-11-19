import { useState } from "react";
import {
  containerDocumentKinds,
  type ContainerDocumentKind,
} from "@glintai/scenescript/project-container-v2";
import { Button } from "./ui/Button";
import { t } from "./ui/i18n";
type Props = {
  busy: boolean;
  label: "containerV2.new" | "containerV2.add";
  onSubmit(kind: ContainerDocumentKind, title: string): void;
};
export function ContainerDocumentForm({ busy, label, onSubmit }: Props) {
  const [kind, setKind] = useState<ContainerDocumentKind | "">(""),
    [title, setTitle] = useState("");
  return (
    <form
      className="container-document-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (kind && title.trim() && !busy) onSubmit(kind, title.trim());
      }}
    >
      <h2 className="ws-row-title">{t(label)}</h2>
      <label className="ws-label">
        {t("containerV2.documentName")}
        <input
          className="g-field"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
          disabled={busy}
        />
      </label>
      <label className="ws-label">
        {t("containerV2.kind")}
        <select
          className="g-field"
          value={kind}
          onChange={(event) => setKind(event.target.value as typeof kind)}
          disabled={busy}
        >
          <option value="">{t("containerV2.choose")}</option>
          {containerDocumentKinds.map((value) => (
            <option key={value} value={value}>
              {t(`containerV2.${value}`)}
            </option>
          ))}
        </select>
      </label>
      <Button type="submit" variant="primary" disabled={!title.trim() || !kind || busy}>
        {t("containerV2.create")}
      </Button>
    </form>
  );
}
