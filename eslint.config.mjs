import eslint from "@eslint/js";
import reactHooks from "eslint-plugin-react-hooks";
import reactRefresh from "eslint-plugin-react-refresh";
import globals from "globals";
import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: ["dist/**", "node_modules/**", "coverage/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    linterOptions: {
      reportUnusedDisableDirectives: "warn",
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      "@typescript-eslint/ban-ts-comment": [
        "error",
        {
          minimumDescriptionLength: 8,
          "ts-nocheck": "allow-with-description",
        },
      ],
      /** ESLint 10：再抛出时附带 cause；遗留 OKX 封装暂不强制 */
      "preserve-caught-error": "off",
    },
  },
  {
    files: ["src/renderer/**/*.{ts,tsx}"],
    languageOptions: {
      globals: {
        ...globals.browser,
      },
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    plugins: {
      "react-hooks": reactHooks,
      "react-refresh": reactRefresh,
    },
    rules: {
      ...reactHooks.configs.flat.recommended.rules,
      /** shadcn / barrel 常见：同文件导出组件与 helper */
      "react-refresh/only-export-components": "off",
      /** load() 内 setState 在此仓库中为有意模式；收紧时再重构 */
      "react-hooks/set-state-in-effect": "warn",
      /** TradingView / 巨型遗留脚本中有无害的中间赋值 */
      "no-useless-assignment": "off",
    },
  },
  {
    files: ["src/server/**/*.ts", "src/node/**/*.ts", "scripts/**/*.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      /** 服务端仍为 CommonJS require + tsx；后续统一 ESM 时可打开 */
      "@typescript-eslint/no-require-imports": "off",
      /** 自 JS 迁入的旧逻辑遗留较多无害赋值 */
      "no-useless-assignment": "off",
      "prefer-const": "warn",
    },
  },
  {
    files: ["vite.config.ts"],
    languageOptions: {
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "@typescript-eslint/no-require-imports": "off",
    },
  },
);
