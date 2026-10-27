import { readFileSync } from "node:fs";
import { join } from "node:path";
import BuildStamp from "./build-stamp";

function pageBuildId(): string {
  try {
    return readFileSync(join(process.cwd(), ".next", "BUILD_ID"), "utf8").trim();
  } catch {
    return "dev";
  }
}

export default function BuildStampServer(): React.ReactNode {
  return <BuildStamp pageBuild={pageBuildId()} />;
}
