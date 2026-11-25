import type { SVGProps } from "react";

function ic(d: string, cls = "") {
  return function Icon({ className = "h-4 w-4", ...props }: SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden={props["aria-label"] ? undefined : true} className={`${className}${cls}`} {...props}>
        <path d={d} />
      </svg>
    );
  };
}

export const Activity = ic("M22 12h-4l-3 9L9 3l-3 9H2");
export const AlertTriangle = ic("M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0zM12 9v4M12 17h.01");
export const ArrowDown = ic("M12 5v14M19 12l-7 7-7-7");
export const CheckCircle2 = ic("M2 12a10 10 0 1 0 20 0a10 10 0 1 0-20 0M16 9l-5.5 5.5L8 12");
export const ChevronDown = ic("M6 9l6 6 6-6");
export const ChevronUp = ic("M6 9l6 6 6-6", " rotate-180");
export const ClipboardCopy = ic("M9 2h6v4H9zM8 4H5a1 1 0 0 0-1 1v15a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3M16 4h3a1 1 0 0 1 1 1v5M21 14H11m4-4-4 4 4 4");
export const Command = ic("M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3");
export const Cpu = ic("M6 6h12v12H6zM9 9h6v6H9zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4");
export const ExternalLink = ic("M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6");
export const ArrowUpRight = ExternalLink;
export const Eye = ic("M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM9 12a3 3 0 1 0 6 0a3 3 0 1 0-6 0");
export const EyeOff = ic("M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM2 2l20 20");
export const FileCode2 = ic("M4 12V4a2 2 0 0 1 2-2h8l4 4v14a2 2 0 0 1-2 2h-3M14 2v4h4M5 16l-3 3 3 3M9 22l3-3-3-3");
export const Filter = ic("M10 20v-6L3 4h18l-7 10v7z");
export const FolderGit2 = ic("M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2 2h9a2 2 0 0 1 2 2v5M11 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0M18 19a2 2 0 1 0 4 0a2 2 0 1 0-4 0M18 19a5 5 0 0 1-5-5v8");
export const GitBranch = ic("M15 6a9 9 0 0 0-9 9V3M15 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 18a3 3 0 1 0 6 0a3 3 0 1 0-6 0");
export const Image = ic("M4 4h16v16H4zM7 9a2 2 0 1 0 4 0a2 2 0 1 0-4 0M20 15l-3-3-11 8");
export const Inbox = ic("M22 12h-6l-2 3h-4l-2-3H2M5 5 2 12v7h20v-7l-3-7H5z");
export const Layers = ic("M12 2 2 7l10 5 10-5zM2 12l10 5 10-5M2 17l10 5 10-5");
export const MessageSquare = ic("M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z");
export const Network = ic("M16 16h6v6h-6zM2 16h6v6H2zM9 2h6v6H9zM5 16v-4h14v4M12 12V8");
export const Pause = ic("M14 4h5v16h-5zM5 4h5v16H5z");
export const Pin = ic("M12 17v5M9 11l-4 4v2h14v-2l-4-4V6h1V3H8v3h1z");
export const PinOff = ic("M12 17v5M9 11l-4 4v2h14v-2l-4-4V6h1V3H8v3h1z", " opacity-55");
export const Play = ic("M5 4l15 8-15 8z");
export const Radio = ic("M16 8a6 6 0 0 1 0 8M19 5a10 10 0 0 1 0 14M5 19a10 10 0 0 1 0-14M8 16a6 6 0 0 1 0-8M10 12a2 2 0 1 0 4 0a2 2 0 1 0-4 0");
export const RefreshCw = ic("M3 12a9 9 0 0 1 15.7-6L21 8M21 3v5h-5M21 12a9 9 0 0 1-15.7 6L3 16M8 16H3v5");
export const Reply = ic("M20 18v-2a4 4 0 0 0-4-4H4M9 17l-5-5 5-5");
export const Rocket = Activity;
export const Search = ic("M21 21l-4.3-4.3M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0");
export const Send = ic("M22 2 15 22l-4-9-9-4zM22 2 11 13");
export const Settings = ic("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9c.26.6.85 1 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z");
export const ShieldAlert = AlertTriangle;
export const SkipBack = ic("M19 5 9 12l10 7zM5 19V5");
export const SkipForward = ic("M19 5 9 12l10 7zM5 19V5", " rotate-180");
export const Sparkles = ic("M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2zM19 3v4M21 5h-4");
export const Users = ic("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-4M5 7a4 4 0 1 0 8 0a4 4 0 1 0-8 0");
export const Wrench = Settings;
export const X = ic("M18 6 6 18M6 6l12 12");
