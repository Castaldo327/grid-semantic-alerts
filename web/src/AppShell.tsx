// The Grid Status app frame around the form: the top bar and the sidebar, measured from gridstatus.io.
// Look only: none of the links or buttons go anywhere.

import type { ReactNode } from "react";
import { EMAIL, Icon } from "./ui";

// Tabler icon paths for each sidebar item.
const I = {
  live: ["M13 3l0 7l6 0l-8 11l0 -7l-6 0l8 -11"],
  insights: ["M16 6h3a1 1 0 0 1 1 1v11a2 2 0 0 1 -4 0v-13a1 1 0 0 0 -1 -1h-10a1 1 0 0 0 -1 1v12a3 3 0 0 0 3 3h11", "M8 8l4 0", "M8 12l4 0", "M8 16l4 0"],
  maps: ["M13 19l-4 -2l-6 3v-13l6 -3l6 3l6 -3v8.5", "M9 4v13", "M15 7v7.5", "M19 16l-2 3h4l-2 3"],
  charts: ["M5 4h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1", "M5 16h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1",
    "M15 12h4a1 1 0 0 1 1 1v6a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-6a1 1 0 0 1 1 -1", "M15 4h4a1 1 0 0 1 1 1v2a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1v-2a1 1 0 0 1 1 -1"],
  nodal: ["M9 11a3 3 0 1 0 6 0a3 3 0 0 0 -6 0", "M17.657 16.657l-4.243 4.243a2 2 0 0 1 -2.827 0l-4.244 -4.243a8 8 0 1 1 11.314 0z"],
  forecast: ["M6.73 17.018a8 8 0 1 1 10.54 0", "M5 19a2 2 0 0 0 2 2h10a2 2 0 1 0 0 -4h-10a2 2 0 0 0 -2 2z", "M11 7a3 3 0 0 0 -3 3"],
  interconnection: ["M9.785 6l8.215 8.215l-2.054 2.054a5.81 5.81 0 1 1 -8.215 -8.215l2.054 -2.054z", "M4 20l3.5 -3.5", "M15 4l-3.5 3.5", "M20 9l-3.5 3.5"],
  trends: ["M3 17l6 -6l4 4l8 -8", "M14 7l7 0l0 7"],
  records: ["M8 21l8 0", "M12 17l0 4", "M7 4l10 0", "M17 4v8a5 5 0 0 1 -10 0v-8", "M5 9m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0", "M19 9m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0"],
  alerts: ["M10 5a2 2 0 1 1 4 0a7 7 0 0 1 4 6v3a4 4 0 0 0 2 3h-16a4 4 0 0 0 2 -3v-3a7 7 0 0 1 4 -6", "M9 17v1a3 3 0 0 0 6 0v-1"],
  eia: ["M14.673 15.36a4.978 4.978 0 0 1 -2.673 -1.36a5 5 0 0 0 -7 0v-9a5 5 0 0 1 7 0a5 5 0 0 0 7 0v7", "M5 21v-7", "M19 16l-2 3h4l-2 3"],
  catalog: ["M3 5a2 2 0 0 1 2 -2h14a2 2 0 0 1 2 2v14a2 2 0 0 1 -2 2h-14a2 2 0 0 1 -2 -2v-14z", "M3 10h18", "M10 3v18"],
  exportData: ["M4 6c0 1.657 3.582 3 8 3s8 -1.343 8 -3s-3.582 -3 -8 -3s-8 1.343 -8 3", "M4 6v6c0 1.657 3.582 3 8 3c1.118 0 2.183 -.086 3.15 -.241", "M20 12v-6",
    "M4 12v6c0 1.657 3.582 3 8 3c.157 0 .312 -.002 .466 -.005", "M16 19h6", "M19 16l3 3l-3 3"],
  search: ["M10 10m-7 0a7 7 0 1 0 14 0a7 7 0 1 0 -14 0", "M21 21l-6 -6"],
  apps: ["M4 4m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z", "M4 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z",
    "M14 14m0 1a1 1 0 0 1 1 -1h4a1 1 0 0 1 1 1v4a1 1 0 0 1 -1 1h-4a1 1 0 0 1 -1 -1z", "M14 7l6 0", "M17 4l0 6"],
  resources: ["M3 19a9 9 0 0 1 9 0a9 9 0 0 1 9 0", "M3 6a9 9 0 0 1 9 0a9 9 0 0 1 9 0", "M3 6l0 13", "M12 6l0 13", "M21 6l0 13"],
  settings: ["M10.325 4.317c.426 -1.756 2.924 -1.756 3.35 0a1.724 1.724 0 0 0 2.573 1.066c1.543 -.94 3.31 .826 2.37 2.37a1.724 1.724 0 0 0 1.065 2.572c1.756 .426 1.756 2.924 0 3.35a1.724 1.724 0 0 0 -1.066 2.573c.94 1.543 -.826 3.31 -2.37 2.37a1.724 1.724 0 0 0 -2.572 1.065c-.426 1.756 -2.924 1.756 -3.35 0a1.724 1.724 0 0 0 -2.573 -1.066c-1.543 .94 -3.31 -.826 -2.37 -2.37a1.724 1.724 0 0 0 -1.065 -2.572c-1.756 -.426 -1.756 -2.924 0 -3.35a1.724 1.724 0 0 0 1.066 -2.573c-.94 -1.543 .826 -3.31 2.37 -2.37c1 .608 2.296 .07 2.572 -1.065z",
    "M9 12a3 3 0 1 0 6 0a3 3 0 0 0 -6 0"],
  more: ["M9 6l6 6l-6 6"],
  selector: ["M8 9l4 -4l4 4", "M16 15l-4 4l-4 -4"],
  menu: ["M4 6l16 0", "M4 12l16 0", "M4 18l16 0"],
};

interface Item { label: string; icon: string[]; more?: boolean }

const NAV: Item[][] = [
  [{ label: "Live", icon: I.live, more: true }, { label: "Insights", icon: I.insights }, { label: "Maps", icon: I.maps, more: true }, { label: "Charts & Dashboards", icon: I.charts }],
  [{ label: "Nodal Analysis", icon: I.nodal }, { label: "Forecast Analysis", icon: I.forecast }, { label: "Interconnection", icon: I.interconnection }],
  [{ label: "Trends", icon: I.trends }, { label: "Record Tracker", icon: I.records }, { label: "Alerts", icon: I.alerts }, { label: "EIA Browser", icon: I.eia }],
  [{ label: "Data Catalog", icon: I.catalog }, { label: "Export Data", icon: I.exportData }],
];

const FOOT: Item[] = [{ label: "All Apps", icon: I.apps }, { label: "Resources", icon: I.resources, more: true }, { label: "Settings", icon: I.settings, more: true }];

function NavItem({ item, current }: { item: Item; current?: boolean }) {
  return (
    <a className="nav-item" aria-current={current ? "page" : undefined}>
      <Icon d={item.icon} stroke={1.5} />
      <span>{item.label}</span>
      {item.more && <span className="nav-more"><Icon d={I.more} size={18} stroke={1.5} /></span>}
    </a>
  );
}

export default function AppShell({ section, page, children }: { section: string; page: string; children: ReactNode }) {
  return (
    <>
      <header className="topbar">
        <button type="button" className="menu-btn" aria-label="Open navigation"><Icon d={I.menu} size={20} stroke={1.5} /></button>
        <span className="logo" aria-hidden="true">
          <svg width="18" height="18" viewBox="0 0 18 18"><circle cx="9" cy="9" r="9" fill="#253232" /><path d="M3.5 10h2.5l1.5-4 2.5 6 1.5-3h3" fill="none" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
        </span>
        <nav className="crumbs" aria-label="Breadcrumb">
          <a className="crumb">{section}</a>
          <span className="crumb-sep" aria-hidden="true">/</span>
          <a className="crumb" aria-current="page">{page}</a>
        </nav>
        <span className="concept">Concept demo<span className="concept-long"> · not affiliated with Grid Status</span></span>
      </header>

      <div className="frame">
        <aside className="sidebar">
          <nav aria-label="Apps">
            {NAV.map((group, i) => (
              <div key={i} className="nav-group">
                {group.map((item) => <NavItem key={item.label} item={item} current={item.label === section} />)}
              </div>
            ))}
          </nav>

          <div className="side-foot">
            <div className="jump">
              <Icon d={I.search} stroke={1.5} />
              <span>Jump to</span>
              <kbd>⌘+K</kbd>
            </div>
            <div className="foot-items">
              {FOOT.map((item) => <NavItem key={item.label} item={item} />)}
            </div>
            <a className="account">
              <span className="avatar" aria-hidden="true">{EMAIL[0].toUpperCase()}</span>
              <span className="account-email">{EMAIL}</span>
              <Icon d={I.selector} size={16} stroke={1.5} />
            </a>
          </div>
        </aside>

        <main className="main">{children}</main>
      </div>
    </>
  );
}
