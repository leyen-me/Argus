import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ChartPanel } from "@/components/app/chart-panel";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { ConfigModal } from "@/components/app/config-modal";
import { DashboardModal } from "@/components/app/dashboard-modal";
import { StrategyCenterModal } from "@/components/app/strategy-center-modal";
import { TradeReviewModal } from "@/components/app/trade-review-modal";
import { LlmChartPreviewModal } from "@/components/app/llm-chart-preview-modal";
import { LlmSessionDetailModal } from "@/components/app/llm-session-detail-modal";
import { LlmPanel } from "@/components/app/llm-panel";
import { StrategiesEmptyState } from "@/components/app/strategies-empty-state";
import { TitleBar } from "@/components/app/title-bar";
import { ARGUS_PROMPT_STRATEGY_SYNC } from "@/components/prompt-strategy-select";
import {
  fetchArgusAuthSession,
  loginArgusPublicPassword,
  setStoredArgusAuthToken,
} from "./argus-auth";
import { initArgusApp } from "./argus-renderer";

const RIGHT_PANEL_COLLAPSED_KEY = "argus.ui.rightPanelCollapsed";
const MOBILE_WORKSPACE_QUERY = "(max-width: 767px)";

function isHeadlessCapturePage(): boolean {
  try {
    const role = new URLSearchParams(window.location.search).get("argus_client_role");
    return role === "headless_capture";
  } catch {
    return false;
  }
}

function readStoredRightPanelCollapsed(): boolean {
  if (isHeadlessCapturePage()) return true;
  try {
    const v = window.localStorage.getItem(RIGHT_PANEL_COLLAPSED_KEY);
    if (v === "1" || v === "true") return true;
    if (v === "0" || v === "false") return false;
  } catch {
    /* private mode / quota */
  }
  return false;
}

function readMobileWorkspaceViewport(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  return window.matchMedia(MOBILE_WORKSPACE_QUERY).matches;
}

function useMobileWorkspaceViewport(): boolean {
  const [mobile, setMobile] = useState(readMobileWorkspaceViewport);

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") return;
    const media = window.matchMedia(MOBILE_WORKSPACE_QUERY);
    const onChange = () => setMobile(media.matches);
    onChange();
    media.addEventListener("change", onChange);
    return () => media.removeEventListener("change", onChange);
  }, []);

  return mobile;
}

function PublicPasswordGate({ onUnlocked }: { onUnlocked: () => void }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError("");
    try {
      await loginArgusPublicPassword(password);
      onUnlocked();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4 text-foreground">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>访问验证</CardTitle>
          <CardDescription>当前访问来自公网，请输入服务器环境变量配置的访问密码。</CardDescription>
        </CardHeader>
        <CardContent>
          <form className="space-y-3" onSubmit={onSubmit}>
            <Input
              autoFocus
              autoComplete="current-password"
              disabled={submitting}
              placeholder="访问密码"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {error ? <div className="text-xs text-destructive">{error}</div> : null}
            <Button className="w-full" disabled={submitting || !password.trim()} type="submit">
              {submitting ? "验证中..." : "进入 Argus"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}

function AuthGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"checking" | "ready" | "locked">("checking");
  const [error, setError] = useState("");

  async function refreshSession(showChecking = true) {
    if (showChecking) setState("checking");
    setError("");
    try {
      const session = await fetchArgusAuthSession();
      if (!session.authRequired || session.authenticated) {
        setState("ready");
        return;
      }
      setStoredArgusAuthToken("");
      setState("locked");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setState("locked");
    }
  }

  useEffect(() => {
    let cancelled = false;
    fetchArgusAuthSession()
      .then((session) => {
        if (cancelled) return;
        if (!session.authRequired || session.authenticated) {
          setState("ready");
          return;
        }
        setStoredArgusAuthToken("");
        setState("locked");
      })
      .catch((e) => {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setState("locked");
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (state === "ready") return <>{children}</>;
  if (state === "locked") {
    return (
      <>
        <PublicPasswordGate onUnlocked={() => void refreshSession()} />
        {error ? (
          <div className="fixed bottom-3 left-1/2 -translate-x-1/2 rounded border border-destructive/40 bg-background px-3 py-2 text-xs text-destructive shadow">
            {error}
          </div>
        ) : null}
      </>
    );
  }
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
      正在检查访问权限...
    </div>
  );
}

function ArgusWorkspace() {
  /** `null`：尚未收到配置同步；`0`：已同步且无策略；`>0`：已有策略 */
  const [strategyOptionCount, setStrategyOptionCount] = useState<number | null>(null);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(readStoredRightPanelCollapsed);
  const headlessCapturePage = isHeadlessCapturePage();
  const mobileWorkspace = useMobileWorkspaceViewport();

  useEffect(() => {
    void initArgusApp();
  }, []);

  useEffect(() => {
    if (headlessCapturePage) return;
    try {
      window.localStorage.setItem(RIGHT_PANEL_COLLAPSED_KEY, rightPanelCollapsed ? "1" : "0");
    } catch {
      /* ignore */
    }
  }, [headlessCapturePage, rightPanelCollapsed]);

  useEffect(() => {
    const onSync = (e: Event) => {
      const detail = (e as CustomEvent<{ options?: unknown[] }>).detail;
      const n = Array.isArray(detail?.options) ? detail.options.length : 0;
      setStrategyOptionCount(n);
    };
    window.addEventListener(ARGUS_PROMPT_STRATEGY_SYNC, onSync);
    return () => window.removeEventListener(ARGUS_PROMPT_STRATEGY_SYNC, onSync);
  }, []);

  const showStrategiesEmpty = strategyOptionCount === 0;
  const effectiveRightPanelCollapsed = !mobileWorkspace && rightPanelCollapsed;

  return (
    <>
      <div className="app bg-background text-foreground">
        <TitleBar />
        <main className="main bg-background">
          {showStrategiesEmpty ? (
            <StrategiesEmptyState />
          ) : (
            <>
              <ChartPanel
                rightPanelCollapsed={rightPanelCollapsed}
                onToggleRightPanel={() => setRightPanelCollapsed((v) => !v)}
              />
              <div
                className={cn(
                  "argus-right-panel flex min-h-0 min-w-0 transition-[flex-basis,flex-grow,max-width,opacity] duration-200 ease-out",
                  effectiveRightPanelCollapsed
                    ? "pointer-events-none max-w-0 flex-[0_0_0] overflow-hidden opacity-0"
                    : "flex-[0.72] border-l border-border/75",
                )}
                aria-hidden={effectiveRightPanelCollapsed}
                inert={effectiveRightPanelCollapsed ? true : undefined}
              >
                <LlmPanel />
              </div>
            </>
          )}
        </main>
      </div>

      <ConfigModal />
      <DashboardModal />
      <TradeReviewModal />
      <StrategyCenterModal />
      <LlmSessionDetailModal />
      <LlmChartPreviewModal />
    </>
  );
}

export default function App() {
  return (
    <AuthGate>
      <ArgusWorkspace />
    </AuthGate>
  );
}
