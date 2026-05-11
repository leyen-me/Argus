import { useEffect, useState } from "react";
import {
  Dialog,
  DialogDescription,
} from "@/components/ui/dialog";
import { AppDialogBody, AppDialogContent, AppDialogHeader } from "@/components/app/ui-shell";
import {
  ARGUS_CONFIG_MODAL_CLOSE,
  ARGUS_CONFIG_MODAL_OPEN,
} from "@/lib/argus-config-modal-events";
import { ConfigModalEmailSection } from "./email-section";
import { ConfigModalFooter } from "./config-modal-footer";
import { ConfigModalLlmSection } from "./llm-section";
import { ConfigModalOkxSection } from "./okx-section";

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
      <AppDialogContent className="max-h-[min(90vh,740px)] w-[min(580px,calc(100%-2rem))] sm:max-w-[580px]">
        <AppDialogHeader title={<span id="config-modal-title">配置中心</span>} eyebrow="system settings" closeId="btn-config-close" />
        <DialogDescription className="sr-only">编辑 LLM、邮件与 OKX 等配置</DialogDescription>

        <AppDialogBody className="py-4">
          <div className="space-y-1">
            <div className="flex flex-col gap-6">
              <section className="space-y-0">
                <h3 className="border-b border-border/80 pb-2 text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">LLM 接口</h3>
                <ConfigModalLlmSection />
              </section>
              <section className="space-y-0">
                <h3 className="border-b border-border/80 pb-2 text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">仓位邮件</h3>
                <ConfigModalEmailSection />
              </section>
              <section className="space-y-0">
                <h3 className="border-b border-border/80 pb-2 text-xs font-semibold tracking-[0.16em] text-muted-foreground uppercase">OKX 永续</h3>
                <ConfigModalOkxSection />
              </section>
            </div>
          </div>
        </AppDialogBody>

        <ConfigModalFooter />
      </AppDialogContent>
    </Dialog>
  );
}
