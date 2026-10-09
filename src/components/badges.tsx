import { absoluteTime, relativeTime, relativeTimeAgo, sourceLabel } from "@/lib/format";
import { PRIORITY_LABELS, STATUS_LABELS, type ClassificationSource, type Priority, type SessionStatus } from "@/lib/types";
import { CheckIcon, CircleInfoIcon, CircleQuestionIcon, OctagonIcon, SparkleIcon, TriangleIcon } from "./icons";

const PRIORITY_STYLES: Record<Exclude<Priority, "none">, string> = {
  critical: "bg-red-50 text-red-700 border-red-500 dark:bg-red-950 dark:text-red-300",
  high: "bg-amber-50 text-amber-700 border-amber-500 dark:bg-amber-950 dark:text-amber-300",
  medium: "bg-yellow-50 text-yellow-700 border-yellow-500 dark:bg-yellow-950 dark:text-yellow-300",
  low: "bg-blue-50 text-blue-700 border-blue-500 dark:bg-blue-950 dark:text-blue-300",
};

const PRIORITY_ICONS: Record<Exclude<Priority, "none">, typeof OctagonIcon> = {
  critical: OctagonIcon,
  high: TriangleIcon,
  medium: CircleQuestionIcon,
  low: CircleInfoIcon,
};

export function PriorityBadge({ priority }: { priority: Priority }) {
  if (priority === "none") return null;
  const Icon = PRIORITY_ICONS[priority];
  return (
    <span
      className={`inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[11px] font-semibold tracking-wide ${PRIORITY_STYLES[priority]}`}
    >
      <Icon size={12} />
      {PRIORITY_LABELS[priority]}
    </span>
  );
}

export function StatusPill({ status, muted = false }: { status: SessionStatus; muted?: boolean }) {
  const label = STATUS_LABELS[status];
  const shared = "inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium border";
  if (status === "needs_attention") {
    return (
      <span
        className={`${shared} ${muted ? "border-amber-500 text-amber-700 dark:text-amber-300" : "border-amber-500 bg-amber-500 text-zinc-950"}`}
      >
        <TriangleIcon size={12} />
        {label}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className={`${shared} ${muted ? "border-red-600 text-red-700 dark:text-red-300" : "border-red-600 bg-red-600 text-white"}`}>
        <OctagonIcon size={12} />
        {label}
      </span>
    );
  }
  if (status === "completed") {
    return (
      <span className={`${shared} border-edge text-green-700 dark:text-green-400`}>
        <CheckIcon size={12} />
        {label}
      </span>
    );
  }
  if (status === "idle") {
    return <span className={`${shared} border-dashed border-zinc-400 text-muted`}>{label}</span>;
  }
  if (status === "ended") {
    return <span className={`${shared} border-edge text-muted`}>{label}</span>;
  }
  const dotColor = status === "working" ? "bg-green-500" : "bg-zinc-400";
  return (
    <span className={`${shared} border-edge text-foreground`}>
      <span className={`inline-block h-2 w-2 rounded-full ${dotColor} ${status === "starting" ? "am-dot-pulse" : ""}`} />
      {label}
    </span>
  );
}

const SOURCE_TITLES: Record<ClassificationSource, string> = {
  rule: "Derived from a hook event",
  ai: "Inferred by local model; confidence is not calibrated",
  fallback: "Contextual classification unavailable; showing rule-based state",
};

export function SourceBadge({ source, confidence }: { source: ClassificationSource; confidence: number | null }) {
  const label = sourceLabel(source, confidence);
  const shared = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium border whitespace-nowrap";
  if (source === "rule") {
    return (
      <span className={`${shared} border-zinc-400 text-muted`} title={SOURCE_TITLES.rule}>
        <CheckIcon size={11} />
        {label}
      </span>
    );
  }
  if (source === "ai") {
    return (
      <span
        className={`${shared} border-violet-300 bg-violet-100 text-violet-700 dark:border-violet-700 dark:bg-violet-900 dark:text-violet-300`}
        title={SOURCE_TITLES.ai}
      >
        <SparkleIcon size={11} />
        {label}
      </span>
    );
  }
  return (
    <span className={`${shared} border-dashed border-zinc-400 text-muted`} title={SOURCE_TITLES.fallback}>
      {label}
    </span>
  );
}

export function RelativeTime({ iso, nowMs, ago = false }: { iso: string; nowMs: number; ago?: boolean }) {
  return (
    <time dateTime={iso} title={absoluteTime(iso)}>
      {ago ? relativeTimeAgo(iso, nowMs) : relativeTime(iso, nowMs)}
    </time>
  );
}
