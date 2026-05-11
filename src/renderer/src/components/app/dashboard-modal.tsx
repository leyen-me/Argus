import { useEffect, useState } from "react"
import { LayoutDashboard } from "lucide-react"

import { TradingDashboardCard } from "@/components/app/trading-dashboard-card"
import { AppDialogBody, AppDialogContent, AppDialogHeader } from "@/components/app/ui-shell"
import { Dialog, DialogDescription } from "@/components/ui/dialog"
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
      <AppDialogContent className="h-[min(86vh,860px)] w-[min(1040px,calc(100%-2rem))] sm:max-w-[1040px]">
        <AppDialogHeader
          title="仪表盘"
          eyebrow="argus dashboard"
          icon={<LayoutDashboard aria-hidden />}
          closeId="btn-dashboard-close"
        />
        <DialogDescription className="sr-only">账户资金、持仓与 Agent 统计</DialogDescription>
        <AppDialogBody className="overflow-auto bg-background/45 p-5 max-sm:p-3 sm:overflow-hidden">
          <TradingDashboardCard embedded active={open} />
        </AppDialogBody>
      </AppDialogContent>
    </Dialog>
  )
}
