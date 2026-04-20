export function TitleBar() {
  return (
    <header className="titlebar">
      <span className="titlebar-traffic-guard" aria-hidden="true" />
      <span className="titlebar-title">Argus</span>
      <div className="titlebar-actions">
        <button
          type="button"
          className="titlebar-config"
          id="btn-fish-mode"
          title="按 ESC 退出"
          aria-pressed="false"
        >
          摸鱼模式
        </button>
        <button type="button" className="titlebar-config" id="btn-open-devtools" title="开发者工具">
          控制台
        </button>
        <button type="button" className="titlebar-config" id="btn-open-config" title="配置中心">
          配置
        </button>
      </div>
    </header>
  );
}
