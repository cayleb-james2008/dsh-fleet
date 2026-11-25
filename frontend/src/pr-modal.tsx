import { useCallback, useEffect, useState } from "react";
import {
  ArrowRight,
  Check,
  CheckCircle2,
  Copy,
  ExternalLink,
  GitBranch,
  GitMerge,
  GitPullRequest,
  ShieldAlert,
  XCircle,
} from "lucide-react";
import { Badge, Button, Dialog, Input, Spinner, Textarea, cn, toast } from "./ui";
import {
  batchCreateWavePr,
  batchMergeVerifiedWave,
  createSessionPr,
  fetchPrPreview,
  type BatchMergeResponse,
  type BatchPrResponse,
  type MergeStrategy,
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

const WAVE_STRATEGIES: Array<{ id: MergeStrategy; label: string }> = [
  { id: "merge", label: "Merge commit" },
  { id: "squash", label: "Squash" },
  { id: "ff", label: "Fast-forward" },
];

export function WaveShipModal({
  open,
  sessions,
  supportsBatchMerge,
  supportsBatchPr,
  onClose,
  onOpenSession,
  onCompleted,
}: {
  open: boolean;
  sessions: Session[];
  supportsBatchMerge: boolean;
  supportsBatchPr: boolean;
  onClose: () => void;
  onOpenSession: (id: string) => void;
  onCompleted: () => void;
}) {
  const [strategy, setStrategy] = useState<MergeStrategy>("merge");
  const [loading, setLoading] = useState(false);
  const [mergePreflight, setMergePreflight] = useState<BatchMergeResponse | null>(null);
  const [prPreview, setPrPreview] = useState<BatchPrResponse | null>(null);
  const [merging, setMerging] = useState(false);
  const [mergeDone, setMergeDone] = useState<BatchMergeResponse | null>(null);
  const [draftPr, setDraftPr] = useState(false);
  const [confirmPr, setConfirmPr] = useState(false);
  const [creatingPr, setCreatingPr] = useState(false);
  const [prDone, setPrDone] = useState<BatchPrResponse | null>(null);

  const runPreflight = useCallback(
    async (strat: MergeStrategy) => {
      setLoading(true);
      setMergeDone(null);
      const [mRes, pRes] = await Promise.all([
        batchMergeVerifiedWave({ strategy: strat, dry_run: true }, sessions, supportsBatchMerge),
        batchCreateWavePr({ confirm: false, dry_run: true }, sessions, supportsBatchPr),
      ]);
      setMergePreflight(mRes);
      setPrPreview(pRes);
      setLoading(false);
    },
    [sessions, supportsBatchMerge, supportsBatchPr],
  );

  useEffect(() => {
    if (!open) {
      setMergeDone(null);
      setPrDone(null);
      setConfirmPr(false);
      return;
    }
    void runPreflight(strategy);
  }, [open, strategy, runPreflight]);

  const cleanIds =
    mergePreflight?.preflight?.ready_ids ??
    mergePreflight?.results.filter((r) => r.clean && r.can_apply).map((r) => r.id) ??
    [];

  const handleMergeClean = async () => {
    if (merging || cleanIds.length === 0) return;
    setMerging(true);
    const res = await batchMergeVerifiedWave(
      { ids: cleanIds, strategy, dry_run: false },
      sessions,
      supportsBatchMerge,
    );
    setMerging(false);
    setMergeDone(res);
    if (!res.ok) {
      toast.error(res.error || "Batch merge failed.");
      return;
    }
    toast.success(
      `Merged ${res.merged_count} clean ${res.merged_count === 1 ? "session" : "sessions"}${res.skipped_count > 0 ? ` (${res.skipped_count} skipped)` : ""}.`,
    );
    onCompleted();
  };

  const prCandidateIds = (prPreview?.results ?? []).map((r) => r.id);
  const handleBatchPr = async () => {
    if (creatingPr || !confirmPr || prCandidateIds.length === 0) return;
    setCreatingPr(true);
    const res = await batchCreateWavePr(
      { ids: prCandidateIds, draft: draftPr, confirm: true, dry_run: false },
      sessions,
      supportsBatchPr,
    );
    setCreatingPr(false);
    setPrDone(res);
    if (!res.ok) {
      toast.error(res.error || "Batch PR creation failed.");
      return;
    }
    if (res.created_count > 0) {
      toast.success(`Created ${res.created_count} GitHub ${res.created_count === 1 ? "PR" : "PRs"}.`);
      onCompleted();
    } else {
      toast.warning("No GitHub PRs were created — check branch/remote status below.");
    }
  };

  const rows = mergePreflight?.results ?? [];

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Wave preflight & shipping"
      description="Inspect non-destructive conflict checks per verified session, merge clean branches in one click, or open confirmation-gated GitHub PRs."
      testId="wave-ship-modal"
      maxWidth="max-w-[700px]"
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Wave merge strategy">
            {WAVE_STRATEGIES.map((st) => (
              <button
                key={st.id}
                type="button"
                aria-pressed={strategy === st.id}
                onClick={() => setStrategy(st.id)}
                className={cn(
                  "rounded-[var(--radius-chip)] px-2.5 h-8 text-[12px] font-medium cursor-pointer transition",
                  strategy === st.id
                    ? "bg-[var(--surface)] text-[var(--ink)] border border-[var(--input)]"
                    : "text-[var(--ink-2)] border border-transparent hover:text-[var(--ink)]",
                )}
              >
                {st.label}
              </button>
            ))}
          </div>
          {mergePreflight && (
            <div className="flex items-center gap-2 mono text-[12px]">
              <Badge tone="success">{mergePreflight.clean_count} clean</Badge>
              {mergePreflight.conflict_count > 0 && (
                <Badge tone="danger">{mergePreflight.conflict_count} conflict</Badge>
              )}
            </div>
          )}
        </div>

        {loading ? (
          <div className="flex items-center gap-2.5 py-6 text-[13px] text-[var(--ink-2)]">
            <Spinner className="size-4" />
            <span>Running non-destructive merge preflight across verified wave...</span>
          </div>
        ) : rows.length === 0 ? (
          <p className="py-4 text-[13px] text-[var(--ink-2)]">
            No verified done sessions are currently waiting to merge or open a PR.
          </p>
        ) : (
          <ul className="max-h-[34vh] overflow-y-auto divide-y divide-[var(--hairline)] rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--surface)]">
            {rows.map((r) => (
              <li key={r.id} className="px-3 py-2.5 space-y-1 text-[13px]">
                <div className="flex flex-wrap items-center gap-2">
                  {r.clean && r.can_apply ? (
                    <CheckCircle2 className="size-4 shrink-0 text-[var(--success-foreground)]" strokeWidth={1.5} aria-hidden />
                  ) : (
                    <XCircle className="size-4 shrink-0 text-[var(--destructive-foreground)]" strokeWidth={1.5} aria-hidden />
                  )}
                  <button
                    type="button"
                    onClick={() => {
                      onOpenSession(r.id);
                      onClose();
                    }}
                    className="font-medium text-[var(--ink)] hover:underline text-left cursor-pointer"
                  >
                    {r.task || r.id}
                  </button>
                  <span className="mono text-[12px] text-[var(--ink-3)]">{r.branch || r.id}</span>
                  {(r.diff_files ?? 0) > 0 && (
                    <span className="mono text-[12px] text-[var(--ink-2)]">
                      {r.diff_files}f <span className="text-[var(--diff-add-fg)]">+{r.diff_add ?? 0}</span>{" "}
                      <span className="text-[var(--diff-del-fg)]">-{r.diff_del ?? 0}</span>
                    </span>
                  )}
                  <Badge tone={r.clean && r.can_apply ? "success" : "danger"} className="ml-auto mono">
                    {r.clean && r.can_apply ? "clean" : "conflict"}
                  </Badge>
                </div>
                {r.conflicting_files.length > 0 && (
                  <p className="pl-6 mono text-[12px] text-[var(--destructive-foreground)] [overflow-wrap:anywhere]">
                    Conflicting files: {r.conflicting_files.join(", ")}
                  </p>
                )}
                {r.error && r.conflicting_files.length === 0 && (
                  <p className="pl-6 text-[12px] text-[var(--destructive-foreground)]">{r.error}</p>
                )}
              </li>
            ))}
          </ul>
        )}

        {mergeDone && (
          <div className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3 text-[12px] text-[var(--ink-2)]">
            Merged <span className="mono font-medium text-[var(--ink)]">{mergeDone.merged_count}</span> /{" "}
            <span className="mono">{mergeDone.total}</span> sessions
            {mergeDone.skipped_count > 0 ? ` (${mergeDone.skipped_count} skipped due to conflicts)` : ""}.
          </div>
        )}

        {prCandidateIds.length > 0 && (
          <div className="rounded-[var(--radius)] border border-[var(--hairline)] bg-[var(--canvas)] p-3 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-[13px] font-medium text-[var(--ink)]">
                Batch Wave PR ({prCandidateIds.length} verified branches)
              </span>
              <label className="inline-flex items-center gap-1.5 text-[12px] text-[var(--ink-2)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={draftPr}
                  onChange={(e) => setDraftPr(e.target.checked)}
                  className="size-4 accent-[var(--blue)]"
                />
                <span>Open as draft PRs</span>
              </label>
            </div>
            <label className="flex items-start gap-2 text-[12px] text-[var(--ink)] cursor-pointer">
              <input
                type="checkbox"
                data-testid="wave-pr-confirm-checkbox"
                checked={confirmPr}
                onChange={(e) => setConfirmPr(e.target.checked)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--blue)]"
              />
              <span>
                I confirm pushing {prCandidateIds.length} verified branches and opening GitHub pull requests against their target branch.
              </span>
            </label>
            {prDone && (
              <ul className="space-y-1 text-[12px]">
                {prDone.results.map((p) => (
                  <li key={p.id} className="flex items-center justify-between gap-2 mono">
                    <span>{p.branch || p.id}</span>
                    {p.url ? (
                      <a
                        href={p.url}
                        target="_blank"
                        rel="noreferrer"
                        className="text-[var(--blue)] hover:underline"
                      >
                        {p.url}
                      </a>
                    ) : (
                      <span className={p.status === "created" ? "text-[var(--success-foreground)]" : "text-[var(--destructive-foreground)]"}>
                        {p.error || p.status}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex flex-wrap items-center justify-end gap-2 pt-2 border-t border-[var(--hairline)]">
          <Button type="button" variant="outline" onClick={onClose}>
            Close
          </Button>
          {prCandidateIds.length > 0 && (
            <Button
              type="button"
              variant="outline"
              data-testid="wave-pr-submit-btn"
              disabled={loading || !confirmPr || creatingPr}
              onClick={() => void handleBatchPr()}
            >
              <GitPullRequest className="size-4" strokeWidth={1.5} aria-hidden />
              <span>{creatingPr ? "Creating PRs..." : `Create ${prCandidateIds.length} Wave PR${prCandidateIds.length === 1 ? "" : "s"}`}</span>
            </Button>
          )}
          <Button
            type="button"
            variant="primary"
            data-testid="wave-merge-clean-btn"
            disabled={loading || cleanIds.length === 0 || merging}
            onClick={() => void handleMergeClean()}
          >
            <GitMerge className="size-4" strokeWidth={1.5} aria-hidden />
            <span>{merging ? "Merging..." : `Merge ${cleanIds.length} clean`}</span>
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
