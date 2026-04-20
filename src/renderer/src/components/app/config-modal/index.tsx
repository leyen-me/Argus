import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { cn } from "@/lib/utils";
import { ConfigModalEmailSection } from "./email-section";
import { ConfigModalFooter } from "./config-modal-footer";
import { ConfigModalIntro } from "./intro";
import { ConfigModalLlmSection } from "./llm-section";
import { ConfigModalOkxSection } from "./okx-section";
import { ConfigModalStrategySection } from "./strategy-section";
import { ConfigModalSymbolsAndInterval } from "./symbols-and-interval";

/** 配置中心：DOM id 与结构需与 `argus-renderer.js` 中 getElementById 保持一致 */
export function ConfigModal() {
  return (
    <div
      className="modal-backdrop"
      id="config-modal"
      hidden
      aria-modal="true"
      role="dialog"
      aria-labelledby="config-modal-title"
    >
      <div
        className={cn(
          "modal flex max-h-[min(90vh,720px)] min-h-0 w-[min(560px,100%)] flex-col overflow-hidden! p-0!",
        )}
      >
        <div className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-5 py-4">
          <h2 className="modal-title m-0 text-base font-semibold leading-none" id="config-modal-title">
            配置中心
          </h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground hover:text-foreground"
            id="btn-config-close"
            aria-label="关闭"
          >
            ×
          </Button>
        </div>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-1 px-5 py-4">
            <ConfigModalIntro />
            <p className="modal-path m-0 text-[11px] leading-snug text-muted-foreground" id="config-file-path" />

            <Accordion
              type="multiple"
              defaultValue={["market", "llm", "email", "okx", "strategy"]}
              className="w-full pt-2"
            >
              <AccordionItem value="market" className="border-border/80">
                <AccordionTrigger className="py-3 text-sm font-medium hover:no-underline">
                  行情与周期
                </AccordionTrigger>
                <AccordionContent>
                  <ConfigModalSymbolsAndInterval />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="llm" className="border-border/80">
                <AccordionTrigger className="py-3 text-sm font-medium hover:no-underline">
                  LLM 接口
                </AccordionTrigger>
                <AccordionContent>
                  <ConfigModalLlmSection />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="email" className="border-border/80">
                <AccordionTrigger className="py-3 text-sm font-medium hover:no-underline">
                  仓位邮件
                </AccordionTrigger>
                <AccordionContent>
                  <ConfigModalEmailSection />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="okx" className="border-border/80">
                <AccordionTrigger className="py-3 text-sm font-medium hover:no-underline">
                  OKX 永续
                </AccordionTrigger>
                <AccordionContent>
                  <ConfigModalOkxSection />
                </AccordionContent>
              </AccordionItem>
              <AccordionItem value="strategy" className="border-border/80">
                <AccordionTrigger className="py-3 text-sm font-medium hover:no-underline">
                  交易策略
                </AccordionTrigger>
                <AccordionContent>
                  <ConfigModalStrategySection />
                </AccordionContent>
              </AccordionItem>
            </Accordion>
          </div>
        </ScrollArea>

        <Separator />
        <ConfigModalFooter />
      </div>
    </div>
  );
}
