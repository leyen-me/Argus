import { Button } from "@/components/ui/button";

export function ConfigModalFooter() {
  return (
    <div className="config-modal-footer flex shrink-0 flex-wrap items-center justify-end gap-2 border-t border-border bg-muted/30 px-5 py-4">
      <Button
        type="button"
        variant="secondary"
        size="sm"
        className="mr-auto"
        id="btn-config-reset"
        title="将用户目录 config.json 恢复为 src/config.json 模板（或内置默认值），API Key 等将清空"
      >
        恢复默认
      </Button>
      <Button type="button" variant="secondary" size="sm" id="btn-config-cancel">
        取消
      </Button>
      <Button type="button" size="sm" id="btn-config-save">
        保存
      </Button>
    </div>
  );
}
