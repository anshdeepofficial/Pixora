import BatchPairBridge from "./batch-pair-bridge";
import JobRecoveryClient from "./job-recovery-client";
import BatchProcessingProgress from "./batch-processing-progress";
import DownloadEnhancementClient from "./download-enhancement-client";
import Editor from "./editor";

export default function Home() {
  return <><BatchPairBridge /><JobRecoveryClient /><BatchProcessingProgress /><DownloadEnhancementClient /><Editor /></>;
}
