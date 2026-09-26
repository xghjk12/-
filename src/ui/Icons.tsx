/**
 * 图标：内联 SVG，避免为几个图标引入依赖，也省掉一次网络请求（PWA 离线时尤其重要）。
 * 统一用 currentColor 描边/填充，尺寸由 CSS 控制。
 */
interface IconProps {
  size?: number;
  className?: string;
}

function base(size: number, className?: string) {
  return {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    className,
    'aria-hidden': true as const,
    focusable: 'false' as const,
  };
}

export function PlayIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="currentColor">
      <path d="M8 5.2c0-.9 1-1.5 1.8-1l9 6.1c.7.5.7 1.5 0 2l-9 6.1c-.8.5-1.8-.1-1.8-1z" />
    </svg>
  );
}

export function PauseIcon({ size = 20, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="currentColor">
      <rect x="7" y="5" width="3.6" height="14" rx="1.2" />
      <rect x="13.4" y="5" width="3.6" height="14" rx="1.2" />
    </svg>
  );
}

export function PrevIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="currentColor">
      <path d="M7 6a1 1 0 0 1 2 0v12a1 1 0 0 1-2 0z" />
      <path d="M18 6.6c0-.9-1-1.4-1.7-.9l-7 5.4c-.6.4-.6 1.3 0 1.8l7 5.4c.7.5 1.7 0 1.7-.9z" />
    </svg>
  );
}

export function NextIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="currentColor">
      <path d="M15 6a1 1 0 0 1 2 0v12a1 1 0 0 1-2 0z" />
      <path d="M6 6.6c0-.9 1-1.4 1.7-.9l7 5.4c.6.4.6 1.3 0 1.8l-7 5.4c-.7.5-1.7 0-1.7-.9z" />
    </svg>
  );
}

export function RepeatIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3.5 20 6.5l-3 3" />
      <path d="M20 6.5H7a3.5 3.5 0 0 0-3.5 3.5v.5" />
      <path d="M7 20.5 4 17.5l3-3" />
      <path d="M4 17.5h13a3.5 3.5 0 0 0 3.5-3.5v-.5" />
    </svg>
  );
}

export function RepeatOneIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3.5 20 6.5l-3 3" />
      <path d="M20 6.5H7a3.5 3.5 0 0 0-3.5 3.5v.5" />
      <path d="M7 20.5 4 17.5l3-3" />
      <path d="M4 17.5h13a3.5 3.5 0 0 0 3.5-3.5v-.5" />
      <path d="M11.4 10.6l1.6-1v4.8" strokeWidth="2" />
    </svg>
  );
}

export function ShuffleIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3.5 20 6.5l-3 3" />
      <path d="M20 6.5h-3.4c-1.4 0-2.7.7-3.5 1.9l-4.2 6.2c-.8 1.2-2.1 1.9-3.5 1.9H4" />
      <path d="M7 20.5 4 17.5l3-3" />
      <path d="M4 6.5h1.4c1.2 0 2.3.5 3.1 1.4" />
      <path d="M20 17.5h-3.4c-1.2 0-2.3-.5-3.1-1.4" />
    </svg>
  );
}

export function QueueIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M4 7h12M4 12h12M4 17h8" />
      <path d="M18 15.5v4" />
      <circle cx="19.5" cy="20.5" r="1.6" />
    </svg>
  );
}

export function VolumeIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5h3l4-3.5v12l-4-3.5H4z" fill="currentColor" />
      <path d="M15 9.5a3.5 3.5 0 0 1 0 5" />
      <path d="M17.5 7a7 7 0 0 1 0 10" />
    </svg>
  );
}

export function MuteIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 9.5h3l4-3.5v12l-4-3.5H4z" fill="currentColor" />
      <path d="M16 10l4 4M20 10l-4 4" />
    </svg>
  );
}

export function SearchIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round">
      <circle cx="10.5" cy="10.5" r="6" />
      <path d="M15.2 15.2 20 20" />
    </svg>
  );
}

export function CloseIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M6 6l12 12M18 6 6 18" />
    </svg>
  );
}

export function FolderIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round">
      <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5h3.2c.6 0 1.1.3 1.5.7l.9 1.2h7.4a2 2 0 0 1 2 2v6.4a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2z" />
    </svg>
  );
}

export function RefreshIcon({ size = 16, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 12a8 8 0 1 1-2.6-5.9" />
      <path d="M20 4v4.5h-4.5" />
    </svg>
  );
}

export function MusicIcon({ size = 18, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9 18V6.5l9-2V16" />
      <circle cx="6.5" cy="18" r="2.5" />
      <circle cx="15.5" cy="16" r="2.5" />
    </svg>
  );
}

export function WarnIcon({ size = 15, className }: IconProps) {
  return (
    <svg {...base(size, className)} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
      <path d="M12 4.5 21 20H3z" strokeLinejoin="round" />
      <path d="M12 10v4.2M12 17.2v.1" />
    </svg>
  );
}
