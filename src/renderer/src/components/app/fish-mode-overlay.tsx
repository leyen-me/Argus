export function FishModeOverlay() {
  return (
    <div
      className="fish-mode-overlay"
      id="fish-mode-overlay"
      hidden
      aria-hidden="true"
      role="dialog"
      aria-modal="true"
      aria-label="按 ESC 退出"
    >
      <p className="fish-mode-hint">按 ESC 退出</p>
    </div>
  );
}
