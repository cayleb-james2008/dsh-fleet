// PR Preview & Confirmation-Gated Create GitHub PR Modal (v0.7.0).
// Mounted at App root (outside mobile Vaul Drawer) so 390x844 touch interaction is never blocked.
import { useEffect, useState } from "react";
import {
  Check,
  Copy,
  ExternalLink,
  GitBranch,
  GitPullRequest,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import { Pill, PillIndicator } from "@/components/kibo-ui/pill";
import { Spinner } from "@/components/ui/spinner";
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
    <Dialog open={session !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        data-testid="pr-preview-modal"
        className="!top-[4vh] max-h-[92dvh] max-w-[680px] gap-2.5 overflow-y-auto p-4"
      >
        <DialogHeader className="pr-8 text-left">
          <DialogTitle className="flex items-center gap-2">
            <GitPullRequest className="size-4 text-accent" strokeWidth={1.5} aria-hidden />
            <span>Pull request preview</span>
          </DialogTitle>
          <DialogDescription>
            Review generated receipt Markdown, copy it, or push and open a confirmation-gated GitHub PR.
          </DialogDescription>
        </DialogHeader>

        {loading || !preview ? (
          <div className="flex items-center gap-2 py-8 text-sm text-ink-2">
            <Spinner className="size-4" />
            <span>Generating PR preview from branch diff and check receipt...</span>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 rounded-card border border-hairline bg-canvas px-3 py-2 text-xs">
              <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-ink">
                <GitBranch className="size-3.5 shrink-0 text-icon" strokeWidth={1.5} aria-hidden />
                <span className="truncate">{preview.head_branch}</span>
                <span className="text-ink-3">→</span>
                <span className="font-medium">{preview.base_branch}</span>
              </span>
              <span className="rounded-chip bg-track px-2 py-0.5 font-mono text-ink-2 tabular-nums">
                {preview.diff_files} {preview.diff_files === 1 ? "file" : "files"}
              </span>
              <span className="rounded-chip bg-diff-add-bg px-1.5 py-0.5 font-mono font-medium text-diff-add-fg tabular-nums">
                +{preview.diff_add}
              </span>
              <span className="rounded-chip bg-diff-del-bg px-1.5 py-0.5 font-mono font-medium text-diff-del-fg tabular-nums">
                −{preview.diff_del}
              </span>
              <Pill
                variant={preview.gh_available ? "success" : "secondary"}
                className="ml-auto px-2 py-0.5 text-xs"
                data-testid="pr-gh-status"
              >
                <PillIndicator variant={preview.gh_available ? "success" : "warning"} />
                <span>{preview.gh_available ? "gh CLI ready" : "gh preview only"}</span>
              </Pill>
            </div>

            {preview.gh_status && !preview.gh_available && (
              <p className="rounded-card border border-hairline bg-board/60 px-3 py-2 text-xs leading-relaxed text-ink-2">
                {preview.gh_status}
              </p>
            )}

            {preview.warnings.length > 0 && (
              <div className="space-y-1 rounded-card border border-hairline bg-pill-pro-bg px-3 py-2 text-xs text-destructive-foreground">
                {preview.warnings.map((w, idx) => (
                  <p key={idx} className="flex items-start gap-1.5">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
                    <span>{w}</span>
                  </p>
                ))}
              </div>
            )}

            <div className="space-y-1.5">
              <label htmlFor="pr-preview-title" className="block text-xs font-medium text-ink-2">
                PR title
              </label>
              <InputGroup>
                <InputGroupInput
                  id="pr-preview-title"
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  className="text-sm max-md:!h-11"
                />
              </InputGroup>
            </div>

            <div className="space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <label htmlFor="pr-preview-body" className="block text-xs font-medium text-ink-2">
                  Markdown body
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void copyMarkdown()}
                  data-testid="pr-copy-markdown"
                  className="h-8 px-2.5 text-xs max-md:min-h-11 max-md:px-3"
                >
                  {copied ? (
                    <Check className="size-3.5 text-success-foreground" strokeWidth={1.5} aria-hidden />
                  ) : (
                    <Copy className="size-3.5" strokeWidth={1.5} aria-hidden />
                  )}
                  <span>{copied ? "Copied" : "Copy Markdown"}</span>
                </Button>
              </div>
              <Textarea
                id="pr-preview-body"
                rows={6}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                className="font-mono text-xs leading-relaxed"
              />
            </div>

            <div
              data-testid="pr-confirm-gate"
              className="space-y-2.5 rounded-card border border-hairline bg-canvas p-3 text-xs"
            >
              <label className="flex cursor-pointer items-center gap-2 text-ink-2 max-md:min-h-11">
                <input
                  id="pr-draft-toggle"
                  type="checkbox"
                  checked={draft}
                  onChange={(e) => setDraft(e.target.checked)}
                  className="size-4 accent-accent"
                />
                <span>Open as Draft PR</span>
              </label>

              <label className="flex cursor-pointer items-start gap-2 font-medium text-ink max-md:min-h-11">
                <input
                  id="pr-confirm-checkbox"
                  type="checkbox"
                  checked={confirmed}
                  onChange={(e) => setConfirmed(e.target.checked)}
                  className="mt-0.5 size-4 shrink-0 accent-accent"
                />
                <span>
                  I confirm pushing <span className="font-mono">{preview.head_branch}</span> and opening a pull request against{" "}
                  <span className="font-mono">{preview.base_branch}</span>.
                </span>
              </label>
            </div>

            {result && (
              <div
                role="status"
                data-testid="pr-create-status"
                className={
                  result.ok
                    ? "rounded-card border border-hairline bg-pill-active-bg px-3 py-2.5 text-xs text-pill-active-fg"
                    : "rounded-card border border-hairline bg-pill-pro-bg px-3 py-2.5 text-xs text-destructive-foreground"
                }
              >
                <p className="font-medium [overflow-wrap:anywhere]">{result.message}</p>
                {result.url && (
                  <a
                    href={result.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="mt-1.5 inline-flex items-center gap-1 font-mono underline"
                  >
                    <span>{result.url}</span>
                    <ExternalLink className="size-3.5" strokeWidth={1.5} aria-hidden />
                  </a>
                )}
              </div>
            )}
          </div>
        )}

        <DialogFooter className="gap-2 pt-2">
          <Button type="button" variant="outline" onClick={onClose} className="max-md:min-h-11 max-md:px-4">
            Close
          </Button>
          <Button
            type="button"
            data-testid="pr-submit-btn"
            disabled={loading || !preview || !confirmed || submitting || (!preview.can_create && !preview.gh_available)}
            onClick={() => void submitPr()}
            className="max-md:min-h-11 max-md:px-4"
          >
            <GitPullRequest className="size-4" strokeWidth={1.5} aria-hidden />
            <span>{submitting ? "Creating PR..." : draft ? "Create Draft PR" : "Create GitHub PR"}</span>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
