export const colors = {
  bg: "#ffffff",
  surface: "#ffffff",
  fg: "#181d26",
  fg2: "#333333",
  muted: "rgba(4, 14, 32, 0.69)",
  border: "#e0e2e6",
  borderSoft: "#eef0f3",
  accent: "#1b61c9",
  accentOn: "#ffffff",
  accentHover: "#254fad",
  success: "#006400",
  warn: "#eab308",
  danger: "#dc2626",
} as const;

export const spacing = {
  1: "4px",
  2: "8px",
  3: "12px",
  4: "16px",
  5: "20px",
  6: "24px",
  8: "32px",
  12: "48px",
} as const;

export const radii = {
  sm: "12px",
  md: "16px",
  lg: "24px",
  pill: "9999px",
} as const;

export const fontFamilies = {
  display: '"Haas Groot Disp", Haas, -apple-system, system-ui, "Segoe UI", Roboto, sans-serif',
  body: "Haas, -apple-system, system-ui, 'Segoe UI', Roboto, sans-serif",
  mono: "ui-monospace, 'SF Mono', 'JetBrains Mono', Menlo, Monaco, Consolas, monospace",
} as const;

export const fontSizes = {
  xs: "12px",
  sm: "14px",
  base: "16px",
  lg: "20px",
  xl: "24px",
  "2xl": "32px",
  "3xl": "40px",
  "4xl": "48px",
} as const;

export const shadows = {
  raised:
    "0 0 1px rgba(0, 0, 0, 0.32), 0 0 2px rgba(0, 0, 0, 0.08), 0 1px 3px rgba(45, 127, 249, 0.28), inset 0 0 0 0.5px rgba(0, 0, 0, 0.06)",
  ring: "0 0 0 1px #e0e2e6",
  focus: "0 0 0 3px rgba(27, 97, 201, 0.3)",
} as const;
