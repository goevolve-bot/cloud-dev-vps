import { useRef } from "react";
import { attachmentUrl, uploadAttachment } from "../api";

const IMAGE_NAME_RE = /\.(png|jpe?g|gif|webp|svg)$/i;

function isImageName(name: string): boolean {
  return IMAGE_NAME_RE.test(name);
}

export interface AttachmentsBarProps {
  readonly project: string;
  readonly taskId: number;
  readonly attachments: readonly string[];
  readonly onUploaded: (filename: string) => void;
}

export function AttachmentsBar({ project, taskId, attachments, onUploaded }: AttachmentsBarProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);

  async function handleFiles(files: FileList | null): Promise<void> {
    if (!files) return;
    for (const file of Array.from(files)) {
      const filename = await uploadAttachment(project, taskId, {
        filename: file.name,
        contentType: file.type || "application/octet-stream",
        data: file,
      });
      onUploaded(filename);
    }
  }

  return (
    <div className="att">
      {attachments.map((name) =>
        isImageName(name) ? (
          <a
            key={name}
            className="thumb"
            href={attachmentUrl(project, taskId, name)}
            target="_blank"
            rel="noreferrer"
          >
            <img className="thumb-img" src={attachmentUrl(project, taskId, name)} alt={name} />
          </a>
        ) : (
          <a
            key={name}
            className="chip mono"
            href={attachmentUrl(project, taskId, name)}
            target="_blank"
            rel="noreferrer"
          >
            {name}
          </a>
        ),
      )}
      <button type="button" className="btn" onClick={() => fileInputRef.current?.click()}>
        + attach
      </button>
      <input
        ref={fileInputRef}
        type="file"
        multiple
        style={{ display: "none" }}
        onChange={(event) => {
          void handleFiles(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}
