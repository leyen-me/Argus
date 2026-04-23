import { useEffect, useState } from "react"
import { LayoutDashboard } from "lucide-react"

import { TradingDashboardCard } from "@/components/app/trading-dashboard-card"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { cn } from "@/lib/utils"
import { ARGUS_DASHBOARD_MODAL_OPEN } from "@/lib/argus-dashboard-modal-events"

export function DashboardModal() {
  const [open, setOpen] = useState(false)

  useEffect(() => {
    const onOpen = () => setOpen(true)
    window.addEventListener(ARGUS_DASHBOARD_MODAL_OPEN, onOpen)
    return () => window.removeEventListener(ARGUS_DASHBOARD_MODAL_OPEN, onOpen)
  }, [])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent
        showCloseButton={false}
        forceMount
        className={cn(
          "flex h-[min(84vh,820px)] w-[min(980px,calc(100%-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-[980px]",
        )}
      >
        <DialogHeader className="shrink-0 space-y-0 border-b border-border px-5 py-4 text-left">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2">
              <LayoutDashboard className="size-4 opacity-80" aria-hidden />
              <DialogTitle className="text-base font-semibold">仪表盘</DialogTitle>
            </div>
            <DialogClose asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                className="shrink-0 text-muted-foreground hover:text-foreground"
                id="btn-dashboard-close"
                aria-label="关闭"
              >
                ×
              </Button>
            </DialogClose>
          </div>
          <DialogDescription className="sr-only">账户资金、持仓与 Agent 统计</DialogDescription>
        </DialogHeader>
        <div className="min-h-0 flex-1 overflow-hidden px-5 pt-5 pb-5">
          <TradingDashboardCard embedded active={open} />
        </div>
      </DialogContent>
    </Dialog>
  )
}
