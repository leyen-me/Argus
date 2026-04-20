import { Button } from "@/components/ui/button";
import { DialogClose, DialogFooter } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export function ConfigModalFooter() {
  return (
    <DialogFooter
      className={cn(
        "config-modal-footer shrink-0 flex-row flex-wrap items-center justify-end gap-2 bg-muted/30 px-5 py-4 sm:justify-end",
        "mx-0 mb-0 rounded-none border-t border-border",
      )}
    >
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mr-auto"
        id="btn-config-reset"
        title="将 SQLite 中的应用设置恢复为代码中的默认种子，API Key 等将清空"
      >
        恢复默认
      </Button>
      <DialogClose asChild>
        <Button type="button" variant="secondary" size="sm" id="btn-config-cancel">
          取消
        </Button>
      </DialogClose>
      <Button type="button" size="sm" id="btn-config-save">
        保存
      </Button>
    </DialogFooter>
  );
}
