/**
 * Small stroke icons (24x24 grid, currentColor). Decorative by default (aria-hidden);
 * pass `title` to make one meaningful to screen readers.
 */
import type { ReactNode, SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  /** Pixel size (width = height). Default 16. */
  size?: number;
  /** Accessible label; when omitted the icon is aria-hidden. */
  title?: string;
}

function make(name: string, paths: ReactNode) {
  const Icon = ({ size = 16, title, ...rest }: IconProps) => (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? 'img' : undefined}
      focusable="false"
      {...rest}
    >
      {title ? <title>{title}</title> : null}
      {paths}
    </svg>
  );
  Icon.displayName = name;
  return Icon;
}

export const IconDashboard = make('IconDashboard', <><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></>);
export const IconLeads = make('IconLeads', <><path d="M8 6h13M8 12h13M8 18h13" /><circle cx="4" cy="6" r="1" /><circle cx="4" cy="12" r="1" /><circle cx="4" cy="18" r="1" /></>);
export const IconTeam = make('IconTeam', <><circle cx="9" cy="8" r="3.5" /><path d="M2.5 20c.7-3.4 3.3-5.5 6.5-5.5s5.8 2.1 6.5 5.5" /><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18 14.8c1.9.7 3.1 2.6 3.5 5.2" /></>);
export const IconPhone = make('IconPhone', <path d="M5 3h3.5l1.8 4.5-2.3 1.4a12 12 0 0 0 7.1 7.1l1.4-2.3L21 15.5V19a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z" />);
export const IconPhoneOff = make('IconPhoneOff', <><path d="M10.7 13.3a12 12 0 0 0 4.4 2.8l1.4-2.3L21 15.5V19a2 2 0 0 1-2 2A17 17 0 0 1 6.4 14.6M4 10.2A17 17 0 0 1 3 5a2 2 0 0 1 2-2h3.5l1.8 4.5-2.3 1.4" /><path d="M3 21 21 3" /></>);
export const IconPhoneIncoming = make('IconPhoneIncoming', <><path d="M5 3h3.5l1.8 4.5-2.3 1.4a12 12 0 0 0 7.1 7.1l1.4-2.3L21 15.5V19a2 2 0 0 1-2 2A17 17 0 0 1 3 5a2 2 0 0 1 2-2z" /><path d="M21 3l-6 6M15 4v5h5" /></>);
export const IconRecordings = make('IconRecordings', <><path d="M3 12h2M7 8v8M11 5v14M15 9v6M19 7v10M21 12h0" /></>);
export const IconSettings = make('IconSettings', <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" /></>);
export const IconDialer = make('IconDialer', <><circle cx="6" cy="5" r="1.3" /><circle cx="12" cy="5" r="1.3" /><circle cx="18" cy="5" r="1.3" /><circle cx="6" cy="11" r="1.3" /><circle cx="12" cy="11" r="1.3" /><circle cx="18" cy="11" r="1.3" /><circle cx="6" cy="17" r="1.3" /><circle cx="12" cy="17" r="1.3" /><circle cx="18" cy="17" r="1.3" /><circle cx="12" cy="22" r="0.6" /></>);
export const IconCallback = make('IconCallback', <><path d="M3 12a9 9 0 1 0 3-6.7" /><path d="M3 4v5h5" /><path d="M12 8v4l3 2" /></>);
export const IconStats = make('IconStats', <><path d="M3 21h18" /><path d="M6 17V11M11 17V6M16 17v-4M20 17V9" /></>);
export const IconLogout = make('IconLogout', <><path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3" /><path d="M10 17l-5-5 5-5M5 12h11" /></>);
export const IconClose = make('IconClose', <path d="M6 6l12 12M18 6 6 18" />);
export const IconCheck = make('IconCheck', <path d="M5 12.5l4.5 4.5L19 7.5" />);
export const IconChevronDown = make('IconChevronDown', <path d="M6 9l6 6 6-6" />);
export const IconChevronUp = make('IconChevronUp', <path d="M6 15l6-6 6 6" />);
export const IconChevronLeft = make('IconChevronLeft', <path d="M15 6l-6 6 6 6" />);
export const IconChevronRight = make('IconChevronRight', <path d="M9 6l6 6-6 6" />);
export const IconSort = make('IconSort', <path d="M8 9l4-4 4 4M8 15l4 4 4-4" />);
export const IconSearch = make('IconSearch', <><circle cx="11" cy="11" r="6.5" /><path d="M20 20l-4.2-4.2" /></>);
export const IconPlus = make('IconPlus', <path d="M12 5v14M5 12h14" />);
export const IconMinus = make('IconMinus', <path d="M5 12h14" />);
export const IconTrash = make('IconTrash', <><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 13h10l1-13M9 7V4h6v3" /></>);
export const IconEdit = make('IconEdit', <><path d="M4 20h4L19 9l-4-4L4 16v4z" /><path d="M13.5 6.5l4 4" /></>);
export const IconUpload = make('IconUpload', <><path d="M12 16V4M7 9l5-5 5 5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>);
export const IconDownload = make('IconDownload', <><path d="M12 4v12M7 11l5 5 5-5" /><path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" /></>);
export const IconPlay = make('IconPlay', <path d="M7 4.5v15l12-7.5-12-7.5z" />);
export const IconPause = make('IconPause', <path d="M8 5v14M16 5v14" />);
export const IconStop = make('IconStop', <rect x="6" y="6" width="12" height="12" rx="1.5" />);
export const IconMic = make('IconMic', <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" /></>);
export const IconMicOff = make('IconMicOff', <><path d="M15 10V6a3 3 0 0 0-5.7-1.3M9 9v2a3 3 0 0 0 4.9 2.3" /><path d="M5 11a7 7 0 0 0 11.5 5.4M19 11a7 7 0 0 1-.4 2.3M12 18v3M3 3l18 18" /></>);
export const IconAlert = make('IconAlert', <><path d="M12 3 2 20h20L12 3z" /><path d="M12 10v4M12 17h0" /></>);
export const IconInfo = make('IconInfo', <><circle cx="12" cy="12" r="9" /><path d="M12 11v5M12 8h0" /></>);
export const IconRefresh = make('IconRefresh', <><path d="M20 11a8 8 0 0 0-14.3-4.3L4 9" /><path d="M4 4v5h5" /><path d="M4 13a8 8 0 0 0 14.3 4.3L20 15" /><path d="M20 20v-5h-5" /></>);
export const IconCalendar = make('IconCalendar', <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>);
export const IconClock = make('IconClock', <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconUser = make('IconUser', <><circle cx="12" cy="8" r="4" /><path d="M4 21c.9-4 4-6 8-6s7.1 2 8 6" /></>);
export const IconNote = make('IconNote', <><path d="M5 3h10l4 4v14H5z" /><path d="M14 3v5h5M8 13h8M8 17h5" /></>);
export const IconFilter = make('IconFilter', <path d="M3 5h18l-7 8v6l-4 2v-8L3 5z" />);
export const IconMore = make('IconMore', <><circle cx="5" cy="12" r="1" /><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /></>);
export const IconExternal = make('IconExternal', <><path d="M14 4h6v6M20 4l-9 9" /><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5" /></>);
export const IconHeadset = make('IconHeadset', <><path d="M4 14v-2a8 8 0 0 1 16 0v2" /><rect x="3" y="14" width="4" height="6" rx="1.5" /><rect x="17" y="14" width="4" height="6" rx="1.5" /><path d="M19 20a3 3 0 0 1-3 2h-3" /></>);
export const IconFlag = make('IconFlag', <><path d="M5 21V4" /><path d="M5 4h11l-2 4 2 4H5" /></>);
export const IconArrowUp = make('IconArrowUp', <path d="M12 19V5M6 11l6-6 6 6" />);
export const IconArrowDown = make('IconArrowDown', <path d="M12 5v14M6 13l6 6 6-6" />);
export const IconArrowRight = make('IconArrowRight', <path d="M5 12h14M13 6l6 6-6 6" />);
export const IconMail = make('IconMail', <><rect x="3" y="5" width="18" height="14" rx="2" /><path d="M3.5 6.5 12 13l8.5-6.5" /></>);
export const IconBuilding = make('IconBuilding', <><path d="M4 21V5a1 1 0 0 1 1-1h9a1 1 0 0 1 1 1v16" /><path d="M15 9h4a1 1 0 0 1 1 1v11M3 21h18M8 8h3M8 12h3M8 16h3" /></>);
export const IconLock = make('IconLock', <><rect x="5" y="11" width="14" height="10" rx="2" /><path d="M8 11V8a4 4 0 0 1 8 0v3" /></>);
export const IconCheckCircle = make('IconCheckCircle', <><circle cx="12" cy="12" r="9" /><path d="M8 12.5l2.7 2.7L16 10" /></>);
export const IconShield = make('IconShield', <path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6l7-3z" />);
