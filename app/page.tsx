import JobRecoveryClient from "./job-recovery-client";
import DownloadEnhancementClient from "./download-enhancement-client";
import VersionClient from "./version-client";
import Editor from "./editor";

export default function Home() {
  return <><VersionClient /><JobRecoveryClient /><DownloadEnhancementClient /><Editor /></>;
}
