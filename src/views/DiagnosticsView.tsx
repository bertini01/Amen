import { errorMessage } from "@/lib/utils";
import { useCallback, useEffect, useState } from "react";
import {
   CheckCircle2,
   ClipboardCopy,
   CloudDownload,
   Cpu,
   FileWarning,
   FolderOpen,
   HardDrive,
   MinusCircle,
   Network,
   RefreshCw,
   Sparkles,
   XCircle,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import { Sparkline } from "@/components/ui/sparkline";
import { useAppStore } from "@/stores/app";
import { useStudioStore } from "../stores/studio";
import { computeTimelineDuration } from "../lib/studioTypes";
import { formatTime } from "../lib/studioTime";
import { api, clipboard } from "@/lib/api";
import { toast } from "@/stores/toast";
import type { YtdlpUpdateInfo } from "@/lib/types";
import { formatBytes } from "@/lib/format";
import { useSystemUsage } from "@/lib/useSystemUsage";

export function DiagnosticsView() {
   const { deps, refreshDeps, appInfo } = useAppStore();
   const [loading, setLoading] = useState(false);
   // Install state lives in the app store (progress events are wired up in
   // App.tsx): as local state, leaving this view mid-install and coming back
   // re-enabled the Install buttons while the first install was still running.
   const installing = useAppStore((s) => s.installing);
   const installProgress = useAppStore((s) => s.installProgress);
   const { setInstalling, setInstallProgress } = useAppStore.getState();
   const [updateInfo, setUpdateInfo] = useState<YtdlpUpdateInfo | null>(null);
   const [updating, setUpdating] = useState(false);
   const usageSamples = useSystemUsage(true);
   const studioProject = useStudioStore((s) => s.project);

   const run = useCallback(async () => {
      setLoading(true);
      await refreshDeps();
      setLoading(false);
   }, []);

   useEffect(() => {
      run();
   }, []);

   const install = async (what: "all" | "yt-dlp" | "ffmpeg") => {
      if (useAppStore.getState().installing) return;
      setInstalling(true);
      setInstallProgress(null);
      try {
         await api.installDependencies(what);
         toast("Installed", "Dependencies are ready.", "success");
         await refreshDeps();
      } catch (e) {
         toast("Install failed", errorMessage(e), "destructive");
      } finally {
         setInstalling(false);
         setInstallProgress(null);
      }
   };

   const checkUpdate = async () => {
      try {
         const info = await api.checkYtdlpUpdate();
         setUpdateInfo(info);
         toast(
            info.updateAvailable ? "Update available" : "yt-dlp is up to date",
            info.updateAvailable
               ? `New version: ${info.latest} (you have ${info.current}).`
               : `You have the latest version (${info.current}).`,
            info.updateAvailable ? "info" : "success",
         );
      } catch (e) {
         toast("Update check failed", errorMessage(e), "destructive");
      }
   };

   const doUpdate = async () => {
      setUpdating(true);
      try {
         const out = await api.updateYtdlp();
         toast(
            "yt-dlp updated",
            out.split("\n").filter(Boolean).pop(),
            "success",
         );
         await refreshDeps();
         setUpdateInfo(null);
      } catch (e) {
         toast("Update failed", errorMessage(e), "destructive");
      } finally {
         setUpdating(false);
      }
   };

   const missing = deps && (!deps.ytdlp.found || !deps.ffmpeg.found);

   return (
      <div className="mx-auto max-w-6xl space-y-5 px-8 py-6">
         <div className="flex items-center justify-between">
            <div>
               <h1 className="text-xl font-semibold tracking-tight">
                  Diagnostics
               </h1>
               <p className="text-sm text-muted-foreground">
                  Real checks of your local environment — not simulated.
               </p>
            </div>
            <Button
               variant="outline"
               size="sm"
               onClick={run}
               disabled={loading}
            >
               {loading ? <Spinner /> : <RefreshCw className="h-3.5 w-3.5" />}
               Re-check
            </Button>
         </div>

         {missing && !loading && (
            <div className="rounded-2xl border border-warning/30 bg-warning/5 p-5">
               <div className="flex items-start gap-3">
                  <FileWarning className="mt-0.5 h-5 w-5 shrink-0 text-warning" />
                  <div className="flex-1">
                     <h3 className="font-semibold">
                        Some components are missing
                     </h3>
                     <p className="mt-1 text-sm text-muted-foreground">
                        Amen needs yt-dlp and FFmpeg to work. You
                        can install them automatically from official sources
                        below, or add them to your PATH and re-check.
                     </p>
                     <div className="mt-3 flex flex-wrap gap-2">
                        <Button
                           size="sm"
                           onClick={() => install("all")}
                           disabled={installing}
                        >
                           {installing ? (
                              <Spinner />
                           ) : (
                              <CloudDownload className="h-3.5 w-3.5" />
                           )}
                           Install both
                        </Button>
                        {!deps?.ytdlp.found && (
                           <Button
                              size="sm"
                              variant="outline"
                              onClick={() => install("yt-dlp")}
                              disabled={installing}
                           >
                              {installing &&
                              installProgress?.stage === "yt-dlp" ? (
                                 <Spinner />
                              ) : (
                                 <CloudDownload className="h-3.5 w-3.5" />
                              )}
                              Install yt-dlp
                           </Button>
                        )}
                        {!deps?.ffmpeg.found && (
                           <Button
                              size="sm"
                              variant="outline"
                              onClick={() => install("ffmpeg")}
                              disabled={installing}
                           >
                              {installing &&
                              installProgress?.stage === "ffmpeg" ? (
                                 <Spinner />
                              ) : (
                                 <CloudDownload className="h-3.5 w-3.5" />
                              )}
                              Install FFmpeg
                           </Button>
                        )}
                     </div>
                  </div>
               </div>
            </div>
         )}

         {installing && installProgress && (
            <Card>
               <CardContent className="p-4">
                  <div className="mb-2 flex items-center justify-between text-sm">
                     <span className="font-medium">
                        {installProgress.message}
                     </span>
                     <Badge variant="muted">{installProgress.stage}</Badge>
                  </div>
                  <Progress
                     value={installProgress.percent ?? 0}
                     indeterminate={installProgress.percent == null}
                  />
               </CardContent>
            </Card>
         )}

         {loading && !deps ? (
            <div className="grid gap-3">
               {[0, 1, 2, 3].map((i) => (
                  <div
                     key={i}
                     className="h-16 animate-pulse rounded-2xl bg-secondary/50"
                  />
               ))}
            </div>
         ) : deps ? (
            <>
               <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <ToolCheck
                     name="yt-dlp"
                     ok={deps.ytdlp.found}
                     version={deps.ytdlp.version ?? "n/a"}
                     source={deps.ytdlp.source}
                     path={deps.ytdlp.path}
                  />
                  <ToolCheck
                     name="FFmpeg"
                     ok={deps.ffmpeg.found}
                     version={deps.ffmpeg.version ?? "n/a"}
                     source={deps.ffmpeg.source}
                     path={deps.ffmpeg.path}
                  />
                  <ToolCheck
                     name="ffprobe"
                     ok={deps.ffprobe.found}
                     version={deps.ffprobe.version ?? "n/a"}
                     source={deps.ffprobe.source}
                     path={deps.ffprobe.path}
                  />
                  <ToolCheck
                     name="Output directory"
                     ok={deps.outputDir.ok}
                     version="writable"
                     source=""
                     path={deps.outputDir.path}
                     error={deps.outputDir.error ?? undefined}
                  />
               </div>

               <div className="grid gap-3 sm:grid-cols-3">
                  <SimpleCheck
                     icon={HardDrive}
                     label="Disk space"
                     ok={deps.diskSpace.ok}
                     value={formatBytes(deps.diskSpace.freeBytes) + " free"}
                     detail={deps.diskSpace.error ?? undefined}
                  />
                  <SimpleCheck
                     icon={Network}
                     label="Network"
                     ok={deps.network.ok}
                     value={
                        deps.network.ok
                           ? `reachable (${deps.network.latencyMs ?? "?"} ms)`
                           : "unreachable"
                     }
                     detail={deps.network.error ?? undefined}
                  />
                  {/* Informational only — Amen never needs Python, so its
                      absence is neutral, not a red failure. */}
                  <SimpleCheck
                     icon={Cpu}
                     label="Python"
                     ok={!!deps.python}
                     neutral={!deps.python}
                     value={deps.python ? "launcher found" : "Not installed (not required)"}
                     detail={deps.python ?? undefined}
                  />
               </div>

               <div className="grid gap-3 lg:grid-cols-2">
                  {/* yt-dlp update */}
                  <Card>
                     <CardContent className="flex h-full flex-col gap-3 p-4">
                        <div className="flex items-center gap-3">
                           <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-primary">
                              <Sparkles className="h-4 w-4" />
                           </div>
                           <div>
                              <div className="text-sm font-medium">
                                 yt-dlp updates
                              </div>
                              <div className="text-[12px] text-muted-foreground">
                                 {updateInfo
                                    ? `You have ${updateInfo.current}. Latest is ${updateInfo.latest}.`
                                    : deps.ytdlp.found
                                      ? `Current version: ${deps.ytdlp.version ?? "unknown"}`
                                      : "yt-dlp is not installed."}
                              </div>
                           </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                           <Button
                              variant="outline"
                              size="sm"
                              onClick={checkUpdate}
                           >
                              <RefreshCw className="h-3.5 w-3.5" />
                              Check for updates
                           </Button>
                           {updateInfo?.updateAvailable && (
                              <Button
                                 size="sm"
                                 onClick={doUpdate}
                                 disabled={updating}
                              >
                                 {updating ? (
                                    <Spinner />
                                 ) : (
                                    <CloudDownload className="h-3.5 w-3.5" />
                                 )}
                                 Update
                              </Button>
                           )}
                        </div>
                     </CardContent>
                  </Card>

                  <Card>
                     <CardContent className="flex h-full flex-col gap-3 p-4">
                        <div className="flex items-center gap-3">
                           <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-secondary text-primary">
                              <FolderOpen className="h-4 w-4" />
                           </div>
                           <div>
                              <div className="text-sm font-medium">
                                 Logs & diagnostics
                              </div>
                              <div className="text-[12px] text-muted-foreground">
                                 {appInfo?.logsDir ? (
                                    <>
                                       Structured logs are stored locally at{" "}
                                       <span className="break-all font-mono text-foreground/70">
                                          {appInfo.logsDir}
                                       </span>
                                       .
                                    </>
                                 ) : (
                                    "Structured logs are stored locally on this PC."
                                 )}
                              </div>
                           </div>
                        </div>
                        <div className="flex flex-wrap gap-2">
                           <Button
                              variant="outline"
                              size="sm"
                              onClick={async () => {
                                 try {
                                    const logs = appInfo?.logsDir ?? (await api.getLogsDir());
                                    await api.openFolder(logs);
                                 } catch (e) {
                                    toast("Couldn't open the logs folder", errorMessage(e), "destructive");
                                 }
                              }}
                           >
                              <FolderOpen className="h-3.5 w-3.5" />
                              Open logs folder
                           </Button>
                           <Button
                              variant="outline"
                              size="sm"
                              onClick={async () => {
                                 let text: string;
                                 try {
                                    text = await api.getDiagnosticText();
                                 } catch (e) {
                                    toast("Couldn't build the report", errorMessage(e), "destructive");
                                    return;
                                 }
                                 try {
                                    await clipboard.writeText(text);
                                    toast(
                                       "Copied",
                                       "Full diagnostic report copied to clipboard.",
                                       "success",
                                    );
                                 } catch (e) {
                                    toast("Couldn't copy", errorMessage(e), "destructive");
                                 }
                              }}
                           >
                              <ClipboardCopy className="h-3.5 w-3.5" />
                              Copy report
                           </Button>
                        </div>
                     </CardContent>
                  </Card>
               </div>

               {/* Real system telemetry — sampled from the actual OS every 1.5s, not simulated. */}
               <div className="grid gap-3 lg:grid-cols-2">
                  <Card>
                     <CardContent className="p-4">
                        <div className="mb-2 flex items-center justify-between">
                           <div className="flex items-center gap-2 text-sm font-medium">
                              <Cpu className="h-4 w-4 text-muted-foreground" />
                              Amen CPU usage
                           </div>
                           <span className="font-mono text-sm text-foreground/80">
                              {usageSamples.length > 0 ? `${usageSamples[usageSamples.length - 1].processCpuPercent.toFixed(1)}%` : "—"}
                           </span>
                        </div>
                        <Sparkline data={usageSamples.map((s) => s.processCpuPercent)} width={520} height={56} className="w-full" />
                     </CardContent>
                  </Card>
                  <Card>
                     <CardContent className="p-4">
                        <div className="mb-2 flex items-center justify-between">
                           <div className="flex items-center gap-2 text-sm font-medium">
                              <HardDrive className="h-4 w-4 text-muted-foreground" />
                              Amen memory usage
                           </div>
                           <span className="font-mono text-sm text-foreground/80">
                              {usageSamples.length > 0 ? `${usageSamples[usageSamples.length - 1].processMemMb.toFixed(0)} MB` : "—"}
                           </span>
                        </div>
                        <Sparkline data={usageSamples.map((s) => s.processMemMb)} width={520} height={56} className="w-full" />
                        {usageSamples.length > 0 && (
                           <p className="mt-1 text-[11px] text-muted-foreground">
                              System: {usageSamples[usageSamples.length - 1].systemMemUsedMb.toFixed(0)} / {usageSamples[usageSamples.length - 1].systemMemTotalMb.toFixed(0)} MB used
                           </p>
                        )}
                     </CardContent>
                  </Card>
               </div>

               {/* Project statistics — real counts from the current Studio project, when one is open. */}
               {studioProject && (
                  <Card>
                     <CardContent className="p-4">
                        <div className="mb-3 text-sm font-medium">Current Studio project</div>
                        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                           <StatTile label="Sources" value={String(studioProject.sources.length)} />
                           <StatTile label="Clips" value={String(studioProject.clips.length)} />
                           <StatTile label="Tracks" value={String(studioProject.timeline.tracks.length)} />
                           <StatTile label="Timeline length" value={formatTime(computeTimelineDuration(studioProject))} />
                        </div>
                     </CardContent>
                  </Card>
               )}

               <p className="px-1 text-[11px] leading-relaxed text-muted-foreground">
                  Components are found on your PATH, at explicit paths
                  configured in Settings, or in the bundled tools folder (
                  {deps.toolsDir}). Installing uses official sources: yt-dlp
                  from GitHub releases, FFmpeg from gyan.dev Windows builds.
                  Nothing is downloaded from third-party sites.
               </p>
            </>
         ) : null}
      </div>
   );
}

function ToolCheck({
   name,
   ok,
   version,
   source,
   path,
   error,
}: {
   name: string;
   ok: boolean;
   version: string;
   source: string;
   path?: string | null;
   error?: string;
}) {
   return (
      <div className="rounded-2xl border border-border bg-card p-4">
         <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-semibold">
               {ok ? (
                  <CheckCircle2 className="h-4 w-4 text-success" />
               ) : (
                  <XCircle className="h-4 w-4 text-destructive" />
               )}
               {name}
            </span>
            <Badge variant={ok ? "success" : "destructive"}>
               {ok ? "Installed" : "Missing"}
            </Badge>
         </div>
         <div className="mt-2 text-[12px] text-muted-foreground">
            <div>
               Version:{" "}
               <span className="font-medium text-foreground/80">{version}</span>
            </div>
            {source && (
               <div>
                  Source:{" "}
                  <span className="font-medium text-foreground/80">
                     {source}
                  </span>
               </div>
            )}
            {path && (
               <div
                  className="truncate"
                  title={path}
               >
                  Path:{" "}
                  <span className="font-mono text-foreground/60">{path}</span>
               </div>
            )}
            {error && <div className="text-destructive">{error}</div>}
         </div>
      </div>
   );
}

function SimpleCheck({
   icon: Icon,
   label,
   ok,
   neutral = false,
   value,
   detail,
}: {
   icon: typeof HardDrive;
   label: string;
   ok: boolean;
   /** Informational row: neither a pass nor a failure. */
   neutral?: boolean;
   value: string;
   detail?: string;
}) {
   return (
      <div className="rounded-2xl border border-border bg-card p-4">
         <div className="flex items-center gap-2 text-sm font-semibold">
            {neutral ? (
               <MinusCircle className="h-4 w-4 text-muted-foreground" />
            ) : ok ? (
               <CheckCircle2 className="h-4 w-4 text-success" />
            ) : (
               <XCircle className="h-4 w-4 text-destructive" />
            )}
            <Icon className="h-4 w-4 text-muted-foreground" />
            {label}
         </div>
         <div className="mt-2 text-[12px] text-muted-foreground">
            <div className="font-medium text-foreground/80">{value}</div>
            {/* The detail is an error only when the check failed — for a
                passing row (e.g. the Python launcher's path) it's just info. */}
            {detail && (
               <div className={ok || neutral ? "mt-0.5 break-all" : "mt-0.5 text-destructive"}>
                  {detail}
               </div>
            )}
         </div>
      </div>
   );
}

function StatTile({ label, value }: { label: string; value: string }) {
   return (
      <div className="rounded-xl border border-border bg-secondary/40 p-3">
         <div className="text-[11px] text-muted-foreground">{label}</div>
         <div className="mt-1 font-mono text-lg font-semibold text-foreground/90">{value}</div>
      </div>
   );
}
