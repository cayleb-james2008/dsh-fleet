// Live Policy Tester (POST /api/policies/test) & Worktree Prune inside the Engines and settings Vaul drawer.
import { useState } from "react";
import { FlaskConical, FolderSync, Play, ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { InputGroup, InputGroupInput } from "@/components/ui/input-group";
import { SegmentedControl, SegmentedControlItem } from "@/components/ui/segmented-control";
import { Pill, PillIndicator } from "@/components/kibo-ui/pill";
import {
  pruneStaleWorktrees,
  testPolicyRoute,
  type Policy,
  type PolicyTestResult,
  type RepoInfo,
  type RuntimeConfig,
} from "./api";
import { toast } from "sonner";

const ENGINE_OPTIONS = ["auto", "opencode", "claude", "codex"] as const;

export function PolicyTesterSection({
  policy,
  config,
  repos,
  supportsServerV050,
  canPrune,
  onPruned,
}: {
  policy: Policy | null;
  config: RuntimeConfig | null;
  repos: RepoInfo[];
  supportsServerV050: boolean;
  canPrune: boolean;
  onPruned?: () => void;
}) {
  const [repo, setRepo] = useState(() => repos[0]?.path || "/workspace/ledger-kit");
  const [task, setTask] = useState("Add regression test coverage and verify edge cases");
  const [engine, setEngine] = useState<string>("auto");
  const [testing, setTesting] = useState(false);
  const [result, setResult] = useState<PolicyTestResult | null>(null);
  const [pruning, setPruning] = useState(false);

  const runTest = async (e: React.FormEvent) => {
    e.preventDefault();
    if (testing) return;
    setTesting(true);
    const res = await testPolicyRoute(
      { repo, task, engine },
      policy,
      config,
      supportsServerV050,
    );
    setResult(res);
    setTesting(false);
  };

  const runPrune = async () => {
    if (pruning) return;
    setPruning(true);
    const res = await pruneStaleWorktrees(supportsServerV050);
    setPruning(false);
    if (res.ok) {
      toast.success(res.message);
      onPruned?.();
    } else {
      toast.error(res.message);
    }
  };

  return (
    <>
      <section className="space-y-3 border-t border-hairline pt-5" aria-label="Live Policy Tester">
        <div className="flex items-center justify-between gap-2">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-ink">
            <FlaskConical className="size-4 text-icon" strokeWidth={1.5} aria-hidden />
            <span>Policy tester</span>
          </h3>
          {result && (
            <Pill variant={result.warnings.length ? "secondary" : "success"} className="px-2 py-0.5 font-mono text-xs">
              <PillIndicator variant={result.warnings.length ? "warning" : "success"} />
              <span>{result.source === "server" ? "live rules" : "policy preview"}</span>
            </Pill>
          )}
        </div>
        <p className="text-xs leading-relaxed text-ink-3">
          Dry-run a repo path, task prompt, and engine choice through <span className="font-mono text-ink-2">policies.rn</span> before dispatching.
        </p>

        <form onSubmit={runTest} className="space-y-2.5">
          <div className="space-y-1">
            <label htmlFor="policy-test-repo" className="block text-xs font-medium text-ink-2">
              Repository path or project
            </label>
            <InputGroup>
              <InputGroupInput
                id="policy-test-repo"
                value={repo}
                onChange={(e) => setRepo(e.target.value)}
                placeholder="/home/you/projects/app"
                className="font-mono text-xs max-md:!h-11"
              />
            </InputGroup>
            {repos.length > 0 && (
              <div className="flex flex-wrap gap-1.5 pt-1">
                {repos.slice(0, 4).map((r) => (
                  <Button
                    key={r.path}
                    type="button"
                    size="sm"
                    variant={repo === r.path ? "default" : "outline"}
                    onClick={() => setRepo(r.path)}
                    className="h-7 px-2 font-mono text-xs max-md:min-h-11"
                  >
                    {r.name}
                  </Button>
                ))}
              </div>
            )}
          </div>

          <div className="space-y-1">
            <label htmlFor="policy-test-task" className="block text-xs font-medium text-ink-2">
              Sample task
            </label>
            <InputGroup>
              <InputGroupInput
                id="policy-test-task"
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder="Describe a sample coding task"
                className="text-xs max-md:!h-11"
              />
            </InputGroup>
          </div>

          <div className="space-y-1">
            <p className="text-xs font-medium text-ink-2">Engine override</p>
            <SegmentedControl aria-label="Policy test engine" size="sm">
              {ENGINE_OPTIONS.map((opt) => (
                <SegmentedControlItem
                  key={opt}
                  aria-pressed={engine === opt}
                  data-checked={engine === opt ? "" : undefined}
                  onClick={() => setEngine(opt)}
                  className="text-xs max-md:!min-h-11"
                >
                  {opt}
                </SegmentedControlItem>
              ))}
            </SegmentedControl>
          </div>

          <Button type="submit" size="sm" variant="outline" disabled={testing} className="max-md:min-h-11 max-md:px-4">
            <Play className="size-3.5" strokeWidth={1.5} aria-hidden />
            <span>{testing ? "Evaluating..." : "Test policy"}</span>
          </Button>
        </form>

        {result && (
          <div
            data-testid="policy-test-result"
            className="space-y-2 rounded-card border border-hairline bg-canvas p-3 text-xs"
          >
            <dl className="grid grid-cols-2 gap-x-3 gap-y-2 font-mono tabular-nums">
              <div>
                <dt className="text-ink-3">Routed engine</dt>
                <dd className="text-ink font-medium">{result.engine}</dd>
              </div>
              <div>
                <dt className="text-ink-3">Model</dt>
                <dd className="truncate text-ink">{result.model || "engine default"}</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-ink-3">Check command</dt>
                <dd className="break-all text-ink">{result.check_cmd}</dd>
              </div>
              <div>
                <dt className="text-ink-3">Concurrency / Timeout</dt>
                <dd className="text-ink">{result.max_parallel} slots · {result.timeout_secs}s</dd>
              </div>
              <div>
                <dt className="text-ink-3">Retry / Steer budget</dt>
                <dd className="text-ink">{result.auto_retry_budget} retry · {result.auto_steer_budget} steer</dd>
              </div>
              <div className="col-span-2">
                <dt className="text-ink-3">Matched rule</dt>
                <dd className="break-all text-ink-2">{result.matched_rule}</dd>
              </div>
              {result.allowed_globs.length > 0 && (
                <div className="col-span-2">
                  <dt className="text-ink-3">Allowed globs</dt>
                  <dd className="break-all text-ink-2">{result.allowed_globs.join(", ")}</dd>
                </div>
              )}
              {result.forbidden_globs.length > 0 && (
                <div className="col-span-2">
                  <dt className="text-ink-3">Forbidden globs</dt>
                  <dd className="break-all text-ink-2">{result.forbidden_globs.join(", ")}</dd>
                </div>
              )}
            </dl>

            {result.warnings.length > 0 && (
              <div className="space-y-1 border-t border-hairline pt-2 text-warning-foreground">
                {result.warnings.map((w, i) => (
                  <p key={i} className="flex items-start gap-1.5">
                    <ShieldAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
                    <span>{w}</span>
                  </p>
                ))}
              </div>
            )}
          </div>
        )}
      </section>

      {canPrune && supportsServerV050 && (
        <section className="border-t border-hairline pt-5">
          <div className="flex items-center justify-between gap-2">
            <div className="min-w-0">
              <h3 className="text-sm font-medium text-ink">Worktree hygiene</h3>
              <p className="text-xs text-ink-3">Remove orphaned git worktrees left by dismissed or stopped runs.</p>
            </div>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={pruning}
              onClick={runPrune}
              className="shrink-0 max-md:min-h-11 max-md:px-4"
            >
              <FolderSync className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span>{pruning ? "Pruning..." : "Prune worktrees"}</span>
            </Button>
          </div>
        </section>
      )}
    </>
  );
}
