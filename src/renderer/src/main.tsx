import { createRoot } from "react-dom/client";
import App from "./App";
import { TooltipProvider } from "@/components/ui/tooltip";
import { installArgusBridge } from "./argus-bridge";
import "./globals-shadcn.css";
import "./styles.css";

installArgusBridge();

createRoot(document.getElementById("root")!).render(
  <TooltipProvider delayDuration={200}>
    <App />
  </TooltipProvider>,
);
