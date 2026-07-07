export type DashboardIconName =
  | "activity"
  | "agent"
  | "alert"
  | "apply"
  | "artifacts"
  | "check"
  | "dashboard"
  | "database"
  | "diagnostics"
  | "disabled"
  | "error"
  | "home"
  | "host"
  | "info"
  | "lock"
  | "revert"
  | "rules"
  | "scan"
  | "secrets"
  | "settings"
  | "warning";

interface DashboardIconProps {
  name: DashboardIconName;
  className?: string;
  title?: string;
}

const paths: Record<DashboardIconName, string[]> = {
  activity: ["M4 19V5", "M4 19h16", "M8 15l3-4 3 2 4-7"],
  agent: [
    "M16 19v-1a4 4 0 0 0-4-4H7a4 4 0 0 0-4 4v1",
    "M9.5 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6",
    "M17 11l2 2 3-5",
  ],
  alert: ["M12 4l9 16H3L12 4Z", "M12 9v4", "M12 17h.01"],
  apply: ["M12 3v11", "M8 7l4-4 4 4", "M5 13v5a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-5"],
  artifacts: ["M12 3 4 7l8 4 8-4-8-4Z", "M4 12l8 4 8-4", "M4 17l8 4 8-4"],
  check: ["M20 6 9 17l-5-5"],
  dashboard: ["M4 11 12 4l8 7", "M6 10.5V20h12v-9.5", "M10 20v-6h4v6"],
  database: ["M5 7c0 2 14 2 14 0S5 5 5 7Z", "M5 7v5c0 2 14 2 14 0V7", "M5 12v5c0 2 14 2 14 0v-5"],
  diagnostics: [
    "M12 3v4",
    "M12 17v4",
    "M3 12h4",
    "M17 12h4",
    "M7.8 7.8l-2.8-2.8",
    "M19 19l-2.8-2.8",
    "M16.2 7.8 19 5",
    "M5 19l2.8-2.8",
    "M9 12a3 3 0 1 0 6 0 3 3 0 0 0-6 0Z",
  ],
  disabled: ["M5 5l14 14", "M20 12a8 8 0 0 1-11.7 7.1", "M4 12A8 8 0 0 1 15.7 4.9"],
  error: ["M18 6 6 18", "M6 6l12 12"],
  home: ["M4 11 12 4l8 7", "M6 10.5V20h12v-9.5"],
  host: ["M12 21s7-6.1 7-11a7 7 0 1 0-14 0c0 4.9 7 11 7 11Z", "M12 10.5h.01"],
  info: ["M12 17v-6", "M12 7h.01", "M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"],
  lock: ["M7 10V8a5 5 0 0 1 10 0v2", "M6 10h12v10H6V10Z", "M12 14v2"],
  revert: ["M8 7H4v4", "M4 11a8 8 0 1 0 2.3-5.7L4 7"],
  rules: ["M6 4h9l3 3v13H6V4Z", "M14 4v4h4", "M9 12h6", "M9 16h6"],
  scan: ["M11 19a8 8 0 1 1 5.7-2.3L21 21", "M8 11h6", "M11 8v6"],
  secrets: ["M7 10V8a5 5 0 0 1 10 0v2", "M6 10h12v10H6V10Z", "M12 14v2"],
  settings: [
    "M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Z",
    "M19.4 15a1.8 1.8 0 0 0 .36 1.98l.05.06-1.7 2.94-.08-.02a1.8 1.8 0 0 0-1.92.54l-.06.07h-3.4l-.06-.07a1.8 1.8 0 0 0-1.92-.54l-.08.02-1.7-2.94.05-.06A1.8 1.8 0 0 0 4.6 15l-.08-.03v-3.94l.08-.03a1.8 1.8 0 0 0-.36-1.98l-.05-.06 1.7-2.94.08.02a1.8 1.8 0 0 0 1.92-.54l.06-.07h3.4l.06.07a1.8 1.8 0 0 0 1.92.54l.08-.02 1.7 2.94-.05.06A1.8 1.8 0 0 0 19.4 11l.08.03v3.94l-.08.03Z",
  ],
  warning: ["M12 4l9 16H3L12 4Z", "M12 9v4", "M12 17h.01"],
};

export function DashboardIcon(props: DashboardIconProps) {
  const iconPaths = paths[props.name].map((d) => <path d={d} key={d} />);
  if (props.title) {
    return (
      <svg
        aria-label={props.title}
        className={props.className ? `icon ${props.className}` : "icon"}
        role="img"
        viewBox="0 0 24 24"
      >
        <title>{props.title}</title>
        {iconPaths}
      </svg>
    );
  }

  return (
    <svg
      aria-hidden="true"
      className={props.className ? `icon ${props.className}` : "icon"}
      focusable="false"
      viewBox="0 0 24 24"
    >
      {iconPaths}
    </svg>
  );
}
