import { useCallback, useEffect, useState } from "react";
import { fetchAttachments } from "../api";

export interface UseAttachmentsResult {
  readonly attachments: string[];
  /** Adds a freshly-uploaded name locally, without waiting for a re-fetch. */
  readonly addLocal: (filename: string) => void;
}

export function useAttachments(project: string, taskId: number): UseAttachmentsResult {
  const [attachments, setAttachments] = useState<string[]>([]);

  useEffect(() => {
    let cancelled = false;
    setAttachments([]);
    fetchAttachments(project, taskId)
      .then((names) => {
        if (!cancelled) setAttachments(names);
      })
      .catch(() => {
        // Best-effort: an empty list is a reasonable fallback here.
      });
    return () => {
      cancelled = true;
    };
  }, [project, taskId]);

  const addLocal = useCallback((filename: string) => {
    setAttachments((current) =>
      current.includes(filename) ? current : [...current, filename].sort(),
    );
  }, []);

  return { attachments, addLocal };
}
