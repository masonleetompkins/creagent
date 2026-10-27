import { readFileSync } from "node:fs";
import { join } from "node:path";
import BuildStamp from "./build-stamp";

// Captured once when the server loads this module so the stamp names the
// build the running code came from — never a newer build compiled later.
const PAGE_BUILD_ID: string = (() => {
  try {
    return readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return "dev";
  }
})();

export default function BuildStampServer(): React.ReactNode {
  return <BuildStamp pageBuild={PAGE_BUILD_ID} />;
}
