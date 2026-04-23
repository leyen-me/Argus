import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import {
  ARGUS_CONFIG_MODAL_CLOSE,
  ARGUS_CONFIG_MODAL_OPEN,
} from "@/lib/argus-config-modal-events";
import { ConfigModalEmailSection } from "./email-section";
import { ConfigModalFooter } from "./config-modal-footer";
import { ConfigModalIntro } from "./intro";
import { ConfigModalLlmSection } from "./llm-section";
import { ConfigModalOkxSection } from "./okx-section";
import { ConfigModalSymbolsAndInterval } from "./symbols-and-interval";

/**
 * 配置中心：shadcn Dialog；表单 id 与 `argus-renderer.js` 中 getElementById 一致。
 * 显隐由 `ARGUS_CONFIG_MODAL_OPEN` / `CLOSE` 事件驱动（见 argus-renderer）。
 */
export function ConfigModal() {
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    const onClose = () => setOpen(false);
    window.addEventListener(ARGUS_CONFIG_MODAL_OPEN, onOpen);
    window.addEventListener(ARGUS_CONFIG_MODAL_CLOSE, onClose);
    return () => {
      window.removeEventListener(ARGUS_CONFIG_MODAL_OPEN, onOpen);
      window.removeEventListener(ARGUS_CONFIG_MODAL_CLOSE, onClose);
    };
  }, []);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        forceMount
        className={cn(
          "flex max-h-[min(90vh,720px)] w-[min(560px,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[560px]",
        )}
      >
        <DialogHeader className="shrink-0 space-y-0 border-b border-border px-5 py-4 text-left">
          <div className="flex items-center justify-between gap-3">
            <DialogTitle className="text-base font-semibold" id="config-modal-title">
              配置中心
            </DialogTitle>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                id="btn-config-close"
                aria-label="关闭"
              >
                ×
              </Button>
            </DialogClose>
          </div>
          <DialogDescription className="sr-only">编辑行情、LLM、邮件与 OKX 等配置</DialogDescription>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          <div className="space-y-1">
            <ConfigModalIntro />
            <p className="modal-path m-0 text-[11px] leading-snug text-muted-foreground" id="config-file-path" />

            <div className="flex flex-col gap-6 pt-4">
              <section className="space-y-0">
                <h3 className="border-b border-border/80 pb-2 text-sm font-medium text-foreground">行情与周期</h3>
                <ConfigModalSymbolsAndInterval />
              </section>
              <section className="space-y-0">
                <h3 className="border-b border-border/80 pb-2 text-sm font-medium text-foreground">LLM 接口</h3>
                <ConfigModalLlmSection />
              </section>
              <section className="space-y-0">
                <h3 className="border-b border-border/80 pb-2 text-sm font-medium text-foreground">仓位邮件</h3>
                <ConfigModalEmailSection />
              </section>
              <section className="space-y-0">
                <h3 className="border-b border-border/80 pb-2 text-sm font-medium text-foreground">OKX 永续</h3>
                <ConfigModalOkxSection />
              </section>
            </div>
          </div>
        </div>

        <ConfigModalFooter />
      </DialogContent>
    </Dialog>
  );
}
