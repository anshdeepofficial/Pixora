import JobRecoveryClient from "./job-recovery-client";
import DownloadEnhancementClient from "./download-enhancement-client";
import Editor from "./editor";

export default function Home() {
  return <><JobRecoveryClient /><DownloadEnhancementClient /><Editor /></>;
}
