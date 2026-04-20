import { ConfigModalEmailSection } from "./email-section";
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
      <div className="modal">
        <div className="modal-header">
          <h2 className="modal-title" id="config-modal-title">
            配置中心
          </h2>
          <button type="button" className="modal-close" id="btn-config-close" aria-label="关闭">
            ×
          </button>
        </div>
        <ConfigModalIntro />
        <ConfigModalSymbolsAndInterval />
        <ConfigModalLlmSection />
        <ConfigModalEmailSection />
        <ConfigModalOkxSection />
        <ConfigModalStrategySection />
      </div>
    </div>
  );
}
