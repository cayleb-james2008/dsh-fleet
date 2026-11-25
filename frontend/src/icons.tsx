import type { SVGProps } from "react";

function ic(d: string, extraCls = "") {
  const ds = d.split("|");
  return function Icon({ className = "h-4 w-4", ...props }: SVGProps<SVGSVGElement>) {
    return (
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={`${className}${extraCls}`} {...props}>
        {ds.map((p, i) => <path key={i} d={p} />)}
      </svg>
    );
  };
}

export const Activity = ic("M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2");
export const AlertTriangle = ic("m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3|M12 9v4|M12 17h.01");
export const ArrowDown = ic("M12 5v14|m19 12-7 7-7-7");
export const CheckCircle2 = ic("M2 12a10 10 0 1 0 20 0a10 10 0 1 0 -20 0|m16 9-5.5 5.5L8 12");
export const ChevronDown = ic("m6 9 6 6 6-6");
export const ChevronUp = ic("m6 9 6 6 6-6", " rotate-180");
export const ClipboardCopy = ic("M9 2h6a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1z|M8 4H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-2|M16 4h2a2 2 0 0 1 2 2v4|M21 14H11|m15 10-4 4 4 4");
export const Command = ic("M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3");
export const Cpu = ic("M12 20v2|M12 2v2|M17 20v2|M17 2v2|M2 12h2|M2 17h2|M2 7h2|M20 12h2|M20 17h2|M20 7h2|M7 20v2|M7 2v2|M6 4h12a2 2 0 0 1 2 2v12a2 2 0 0 1 -2 2h-12a2 2 0 0 1 -2 -2v-12a2 2 0 0 1 2 -2z|M9 8h6a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-6a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1z");
export const ExternalLink = ic("M15 3h6v6|M10 14 21 3|M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6");
export const ArrowUpRight = ExternalLink;
export const Eye = ic("M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0|M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0");
export const EyeOff = ic("M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0|m2 2 20 20");
export const FileCode2 = ic("M4 12.15V4a2 2 0 0 1 2-2h8l4 4v14a2 2 0 0 1-2 2h-3.35|M14 2v4h4|m5 16-3 3 3 3|m9 22 3-3-3-3");
export const Filter = ic("M10 20v-6L3 4h18l-7 10v7z");
export const FolderGit2 = ic("M18 19a5 5 0 0 1-5-5v8|M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4l2 2h9a2 2 0 0 1 2 2v5|M11 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0|M18 19a2 2 0 1 0 4 0a2 2 0 1 0 -4 0");
export const GitBranch = ic("M15 6a9 9 0 0 0-9 9V3|M15 6a3 3 0 1 0 6 0a3 3 0 1 0 -6 0|M3 18a3 3 0 1 0 6 0a3 3 0 1 0 -6 0");
export const Image = ic("M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14a2 2 0 0 1 2 -2z|M7 9a2 2 0 1 0 4 0a2 2 0 1 0 -4 0|m21 15-3-3-12 9");
export const Inbox = ic("M22 12h-6l-2 3h-4l-2-3H2|M5 5 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3-7H5z");
export const Layers = ic("M12 2 2 7l10 5 10-5z|M2 12l10 5 10-5|M2 17l10 5 10-5");
export const MessageSquare = ic("M22 17a2 2 0 0 1-2 2H7l-5 3V5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2z");
export const Network = ic("M16 16h6v6h-6z|M2 16h6v6H2z|M9 2h6v6H9z|M5 16v-4h14v4|M12 12V8");
export const Pause = ic("M14 4h5v16h-5z|M5 4h5v16H5z");
export const Pin = ic("M12 17v5|M9 11l-4 4v2h14v-2l-4-4V6h1V3H8v3h1z");
export const PinOff = ic("M12 17v5|M9 11l-4 4v2h14v-2l-4-4V6h1V3H8v3h1z", " opacity-55");
export const Play = ic("M5 4l15 8-15 8z");
export const Radio = ic("M16.2 7.8a6 6 0 0 1 0 8.4|M19 5a10 10 0 0 1 0 14|M5 19a10 10 0 0 1 0-14|M7.8 16.2a6 6 0 0 1 0-8.4|M10 12a2 2 0 1 0 4 0a2 2 0 1 0 -4 0");
export const RefreshCw = ic("M3 12a9 9 0 0 1 15.7-6L21 8|M21 3v5h-5|M21 12a9 9 0 0 1-15.7 6L3 16|M8 16H3v5");
export const Reply = ic("M20 18v-2a4 4 0 0 0-4-4H4|m9 17-5-5 5-5");
export const Rocket = Activity;
export const Search = ic("m21 21-4.3-4.3|M3 11a8 8 0 1 0 16 0a8 8 0 1 0 -16 0");
export const Send = ic("m22 2-7 20-4-9-9-4z|M22 2 11 13");
export const Settings = ic("M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915|M9 12a3 3 0 1 0 6 0a3 3 0 1 0 -6 0");
export const ShieldAlert = AlertTriangle;
export const SkipBack = ic("M19 5 9 12l10 7z|M5 19V5");
export const SkipForward = ic("M19 5 9 12l10 7z|M5 19V5", " rotate-180");
export const Sparkles = ic("M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z|M19 3v4|M21 5h-4");
export const Users = ic("M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2|M16 3.1a4 4 0 0 1 0 7.8|M22 21v-2a4 4 0 0 0-3-3.9|M5 7a4 4 0 1 0 8 0a4 4 0 1 0 -8 0");
export const Wrench = Settings;
export const X = ic("M18 6 6 18|m6 6 12 12");
