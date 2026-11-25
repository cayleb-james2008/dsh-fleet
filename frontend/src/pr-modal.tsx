import { useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  ShieldAlert,
} from "lucide-react";
import { Badge, Button, Dialog, Input, Spinner, Textarea, toast } from "./ui";
import {
  createSessionPr,
  fetchPrPreview,
  type PrCreateResult,
  type PrPreview,
  type Session,
} from "./api";

export function PrPreviewModal({
  session,
  supportsServerV070,
  onClose,
  onCreated,
}: {
  session: Session | null;
  supportsServerV070: boolean;
  onClose: () => void;
  onCreated?: () => void;
}) {
  const [loading, setLoading] = useState(false);
  const [preview, setPreview] = useState<PrPreview | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [copied, setCopied] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<PrCreateResult | null>(null);

  useEffect(() => {
    if (!session) {
      setPreview(null);
      setResult(null);
      setConfirmed(false);
      return;
    }
    let alive = true;
    setLoading(true);
    setResult(null);
    setConfirmed(false);
    setDraft(false);
    void fetchPrPreview(session, supportsServerV070).then((res) => {
      if (!alive) return;
      setPreview(res);
      setTitle(res.title);
      setBody(res.body);
      setLoading(false);
    });
    return () => {
      alive = false;
    };
  }, [session, supportsServerV070]);

  const copyMarkdown = async () => {
    const full = `# ${title.trim()}\n\n${body}`;
    try {
      await navigator.clipboard.writeText(full);
      setCopied(true);
      toast.success("Copied PR title and Markdown body.");
      setTimeout(() => setCopied(false), 1800);
    } catch {
      toast.error("Clipboard access was blocked by the browser.");
    }
  };

  const submitPr = async () => {
    if (!session || !confirmed || submitting) return;
    if (!title.trim()) {
      toast.error("Enter a PR title first.");
      return;
    }
    setSubmitting(true);
    setResult(null);
    const res = await createSessionPr(
      session.id,
      { title: title.trim(), body, draft, confirm: true },
      supportsServerV070,
    );
    setSubmitting(false);
    setResult(res);
    if (res.ok) {
      toast.success(res.message);
      onCreated?.();
    } else {
      toast.error(res.error || res.message);
    }
  };

  return (
    <Dialog
      open={session !== null}
      onClose={onClose}
      title="Pull request preview"
      description="Review generated receipt Markdown, copy it, or push and open a confirmation-gated GitHub PR."
      testId="pr-preview-modal"
      maxWidth="max-w-[680px]"
    >
      {loading || !preview ? (
        <div className="flex items-center gap-2.5 py-8 text-[14px] text-[var(--ink-2)]">
          <Spinner className="size-4" />
          <span>Generating PR preview from branch diff and check receipt...</span>
        </div>
      ) : (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center gap-2 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] px-3 py-2.5 text-[13px]">
            <span className="inline-flex min-w-0 items-center gap-1.5 mono text-[12px] text-[var(--ink)]">
              <GitBranch className="size-3.5 shrink-0 text-[var(--icon)]" strokeWidth={1.5} aria-hidden />
              <span className="truncate">{preview.head_branch}</span>
              <ArrowRight className="size-3.5 shrink-0 text-[var(--ink-3)]" strokeWidth={1.5} aria-hidden />
              <span className="font-medium">{preview.base_branch}</span>
            </span>
            <Badge tone="neutral" className="mono">
              {preview.diff_files} {preview.diff_files === 1 ? "file" : "files"}
            </Badge>
            <span className="rounded-[var(--radius-chip)] bg-[var(--diff-add-bg)] px-2 py-0.5 mono text-[12px] font-medium text-[var(--diff-add-fg)]">
              +{preview.diff_add}
            </span>
            <span className="rounded-[var(--radius-chip)] bg-[var(--diff-del-bg)] px-2 py-0.5 mono text-[12px] font-medium text-[var(--diff-del-fg)]">
              -{preview.diff_del}
            </span>
            <Badge
              tone={preview.gh_available ? "success" : "warning"}
              className="ml-auto"
              data-testid="pr-gh-status"
            >
              {preview.gh_available ? "gh CLI ready" : "gh preview only"}
            </Badge>
          </div>

          {preview.gh_status && !preview.gh_available && (
            <p className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--board)] px-3 py-2.5 text-[13px] leading-relaxed text-[var(--ink-2)]">
              {preview.gh_status}
            </p>
          )}

          {preview.warnings.length > 0 && (
            <div className="space-y-1.5 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--bad-soft)] px-3 py-2.5 text-[13px] text-[var(--destructive-foreground)]">
              {preview.warnings.map((w, idx) => (
                <p key={idx} className="flex items-start gap-2">
                  <ShieldAlert className="mt-0.5 size-4 shrink-0" strokeWidth={1.5} aria-hidden />
                  <span>{w}</span>
                </p>
              ))}
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="pr-preview-title" className="block text-[13px] font-medium text-[var(--ink-2)]">
              PR title
            </label>
            <Input
              id="pr-preview-title"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <label htmlFor="pr-preview-body" className="block text-[13px] font-medium text-[var(--ink-2)]">
                Markdown body
              </label>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={() => void copyMarkdown()}
                data-testid="pr-copy-markdown"
              >
                {copied ? (
                  <Check className="size-3.5 text-[var(--success-foreground)]" strokeWidth={1.5} aria-hidden />
                ) : (
                  <Copy className="size-3.5" strokeWidth={1.5} aria-hidden />
                )}
                <span>{copied ? "Copied" : "Copy Markdown"}</span>
              </Button>
            </div>
            <Textarea
              id="pr-preview-body"
              rows={7}
              value={body}
              onChange={(e) => setBody(e.target.value)}
              className="mono text-[12px] leading-relaxed"
            />
          </div>

          <div
            data-testid="pr-confirm-gate"
            className="space-y-2.5 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3.5 text-[13px]"
          >
            <label className="flex cursor-pointer items-center gap-2.5 text-[var(--ink-2)] max-md:min-h-11">
              <input
                id="pr-draft-toggle"
                type="checkbox"
                checked={draft}
                onChange={(e) => setDraft(e.target.checked)}
                className="size-4 accent-[var(--blue)]"
              />
              <span>Open as Draft PR</span>
            </label>

            <label className="flex cursor-pointer items-start gap-2.5 font-medium text-[var(--ink)] max-md:min-h-11">
              <input
                id="pr-confirm-checkbox"
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
                className="mt-1 size-4 shrink-0 accent-[var(--blue)]"
              />
              <span>
                I confirm pushing <span className="mono text-[12px]">{preview.head_branch}</span> and opening a pull request against{" "}
                <span className="mono text-[12px]">{preview.base_branch}</span>.
              </span>
            </label>
          </div>

          {result && (
            <div
              role="status"
              data-testid="pr-create-status"
              className={
                result.ok
                  ? "rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--ok-soft)] px-3.5 py-2.5 text-[13px] text-[var(--success-foreground)]"
                  : "rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--bad-soft)] px-3.5 py-2.5 text-[13px] text-[var(--destructive-foreground)]"
              }
            >
              <p className="font-medium [overflow-wrap:anywhere]">{result.message}</p>
              {result.url && (
                <a
                  href={result.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1.5 inline-flex items-center gap-1.5 mono text-[12px] underline"
                >
                  <span>{result.url}</span>
                  <ExternalLink className="size-3.5" strokeWidth={1.5} aria-hidden />
                </a>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-[var(--hairline)]">
            <Button type="button" variant="outline" onClick={onClose}>
              Close
            </Button>
            <Button
              type="button"
              variant="primary"
              data-testid="pr-submit-btn"
              disabled={loading || !preview || !confirmed || submitting || (!preview.can_create && !preview.gh_available)}
              onClick={() => void submitPr()}
            >
              <GitPullRequest className="size-4" strokeWidth={1.5} aria-hidden />
              <span>{submitting ? "Creating PR..." : draft ? "Create Draft PR" : "Create GitHub PR"}</span>
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}
