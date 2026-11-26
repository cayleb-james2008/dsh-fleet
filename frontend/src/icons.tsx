import type { SVGProps } from "react";

function ic(d: string, cls = "") {
  return function Icon({ className = "", ...props }: SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden={props["aria-label"] ? undefined : true} className={`${/\bh-/.test(className) ? className : `h-3.5 w-3.5 ${className}`}${cls}`.trim()} {...props}>
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
export const ClipboardCopy = ic("M8 2h8v4H8zM6 4H4v16h16V4h-2M16 13H9l3-3m-3 3 3 3");
const EYE_D = "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z";
export const Eye = ic(`${EYE_D}M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z`);
export const EyeOff = ic(`${EYE_D}M2 2l20 20`);
export const Command = Activity;
export const FileCode2 = ic("M5 3h9l5 5v13H5zM14 3v5h5M10 13l-2 2 2 2M14 13l2 2-2 2");
export const Filter = ic("M10 20v-6L3 4h18l-7 10v7z");
export const FolderGit2 = ic("M3 6h6l2 2h10v11H3zM9 13h6");
export const GitBranch = ic("M15 6a9 9 0 0 0-9 9V3M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6z");
export const Hash = ic("M4 9h16M4 15h16M10 3 8 21M16 3l-2 18");
export const Image = ic("M4 4h16v16H4zM7 9a2 2 0 1 0 4 0a2 2 0 1 0-4 0M20 15l-3-3-11 8");
export const Inbox = ic("M22 12h-6l-2 3h-4l-2-3H2M5 5 2 12v7h20v-7l-3-7z");
export const Layers = ic("M12 2 2 7l10 5 10-5zM2 12l10 5 10-5M2 17l10 5 10-5");
export const MessageSquare = ic("M21 15H7l-4 4V4h18z");
export const Network = ic("M16 16h6v6h-6zM2 16h6v6H2zM9 2h6v6H9zM5 16v-4h14v4M12 12V8");
export const Pause = ic("M14 4h5v16h-5zM5 4h5v16H5z");
const PIN_D = "M12 17v5M9 11l-4 4v2h14v-2l-4-4V6h1V3H8v3h1z";
export const Pin = ic(PIN_D);
export const PinOff = ic(PIN_D, " opacity-55");
export const Play = ic("M5 4l15 8-15 8z");
export const Plus = ic("M12 5v14M5 12h14");
export const Radio = ic("M12 12a2 2 0 1 0 0 .1M8 8a6 6 0 0 0 0 8M16 8a6 6 0 0 1 0 8M5 5a10 10 0 0 0 0 14M19 5a10 10 0 0 1 0 14");
export const RefreshCw = ic("M21 12a9 9 0 1 1-3-6.7L21 8M21 3v5h-5");
export const Reply = ic("M20 18v-2a4 4 0 0 0-4-4H4M9 17l-5-5 5-5");
export const Rocket = Activity;
export const Search = ic("M21 21l-4.3-4.3M3 11a8 8 0 1 0 16 0a8 8 0 1 0-16 0");
export const Send = ic("M22 2 15 22l-4-9-9-4zM22 2 11 13");
export const Settings = ic("M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM12 2l1.8 2.6 3.1-.4.9 3 2.8 1.5-1 3 1 3-2.8 1.5-.9 3-3.1-.4L12 22l-1.8-2.6-3.1.4-.9-3-2.8-1.5 1-3-1-3 2.8-1.5.9-3 3.1.4z");
export const ShieldAlert = AlertTriangle;
export const SkipBack = ic("M19 5 9 12l10 7zM5 19V5");
export const SkipForward = ic("M19 5 9 12l10 7zM5 19V5", " rotate-180");
export const Cpu = ic("M6 6h12v12H6zM10 10h4v4h-4zM9 2v4M15 2v4M9 18v4M15 18v4M2 9h4M2 15h4M18 9h4M18 15h4");
export const ExternalLink = ic("M15 3h6v6M10 14 21 3M18 13v6H4V5h7");
export const ArrowUpRight = ExternalLink;
export const Trash2 = ic("M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6");
export const Users = ic("M16 21v-2a4 4 0 0 0-8 0v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z");
export const Wrench = ic("M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z");
export const X = ic("M18 6 6 18M6 6l12 12");
