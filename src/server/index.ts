import "dotenv/config";

import path from "node:path";
import { bootstrapArgusServer } from "../../internal/app/lifecycle/bootstrap.js";

bootstrapArgusServer({
  distDir: path.resolve(process.cwd(), "dist"),
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
