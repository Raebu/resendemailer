import type { ReactNode, SVGProps } from 'react';

export type MailIconName =
  | 'menu' | 'search' | 'settings' | 'sync' | 'inbox' | 'star' | 'send'
  | 'draft' | 'clock' | 'archive' | 'trash' | 'compose' | 'back' | 'attach'
  | 'reply' | 'more' | 'close' | 'mail' | 'check';

const paths:Record<MailIconName,ReactNode>={
  menu:<><path d="M4 6h16M4 12h16M4 18h16"/></>,
  search:<><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></>,
  settings:<><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06-2.83 2.83-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.04 1.56V21h-4v-.08A1.7 1.7 0 0 0 8.96 19.36a1.7 1.7 0 0 0-1.87.34l-.06.06-2.83-2.83.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.04H3v-4h.04A1.7 1.7 0 0 0 4.6 8.92a1.7 1.7 0 0 0-.34-1.87L4.2 7l2.83-2.83.06.06a1.7 1.7 0 0 0 1.87.34A1.7 1.7 0 0 0 10 3.04V3h4v.04a1.7 1.7 0 0 0 1.04 1.53 1.7 1.7 0 0 0 1.87-.34l.06-.06L19.8 7l-.06.05a1.7 1.7 0 0 0-.34 1.87A1.7 1.7 0 0 0 20.96 10H21v4h-.04A1.7 1.7 0 0 0 19.4 15Z"/></>,
  sync:<><path d="M20 7v5h-5"/><path d="M4 17v-5h5"/><path d="M6.1 9A7 7 0 0 1 18.5 6.5L20 12M4 12l1.5 5.5A7 7 0 0 0 17.9 15"/></>,
  inbox:<><path d="M4 5h16l2 8v6H2v-6l2-8Z"/><path d="M2 13h5l2 3h6l2-3h5"/></>,
  star:<><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></>,
  send:<><path d="m4 4 17 8-17 8 3-8-3-8Z"/><path d="M7 12h14"/></>,
  draft:<><path d="M5 3h10l4 4v14H5V3Z"/><path d="M15 3v5h5M8 13h8M8 17h6"/></>,
  clock:<><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></>,
  archive:<><path d="M4 8h16v12H4V8ZM3 4h18v4H3V4Z"/><path d="M9 12h6"/></>,
  trash:<><path d="M4 7h16M9 7V4h6v3M7 7l1 14h8l1-14M10 11v6M14 11v6"/></>,
  compose:<><path d="M4 20h4l11-11-4-4L4 16v4Z"/><path d="m13.5 6.5 4 4"/></>,
  back:<><path d="m15 18-6-6 6-6"/></>,
  attach:<><path d="m8.5 12.5 6.8-6.8a3 3 0 0 1 4.2 4.2l-8.4 8.4a5 5 0 0 1-7.1-7.1L12.2 3"/><path d="m7 15 8-8"/></>,
  reply:<><path d="m10 8-5 4 5 4v-3h4c3 0 5 1 6 4 0-6-3-9-8-9h-2Z"/></>,
  more:<><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></>,
  close:<><path d="m6 6 12 12M18 6 6 18"/></>,
  mail:<><rect x="3" y="5" width="18" height="14" rx="2"/><path d="m4 7 8 6 8-6"/></>,
  check:<><path d="m5 12 4 4L19 6"/></>,
};

export function MailIcon({name,size=22,className,...props}:{name:MailIconName;size?:number;className?:string}&Omit<SVGProps<SVGSVGElement>,'name'>){
  return <svg
    viewBox="0 0 24 24"
    width={size}
    height={size}
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className={className}
    {...props}
  >{paths[name]}</svg>;
}
