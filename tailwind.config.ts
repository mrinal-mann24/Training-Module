import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        wandor: {
          dark: "#0a0a0a",
          text: "#1a1a1a",
          muted: "#767676",
          prompt: "#905831",
        },
        neutral: {
          0: "#FFFFFF",
          50: "#F7F7F8",
          100: "#ECECEE",
          200: "#DEDEE2",
          400: "#9A9AA2",
          600: "#5C5C64",
          800: "#232326",
          900: "#141416",
          950: "#0B0B0C",
        },
        "bg-canvas": "var(--bg-canvas)",
        "bg-surface": "var(--bg-surface)",
        "bg-surface-raised": "var(--bg-surface-raised)",
        "bg-user-bubble": "var(--bg-user-bubble)",
        "border-default": "var(--border-default)",
        "border-subtle": "var(--border-subtle)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-muted": "var(--text-muted)",
        accent: "var(--accent)",
        "accent-hover": "var(--accent-hover)",
        "accent-subtle": "var(--accent-subtle)",
        "ai-thinking": "var(--ai-thinking)",
        "status-success": "#1F9254",
        "status-warning": "#B7791F",
        "status-error": "#D0342C",
        "status-info": "#905831",
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "16px",
        xl: "20px",
        full: "9999px",
      },
      fontFamily: {
        sans: ["Geist", "sans-serif"],
        display: ['"Special Elite"', "serif"],
        mono: [
          "ui-monospace",
          '"SF Mono"',
          '"JetBrains Mono"',
          "monospace",
        ],
      },
      fontSize: {
        xs: ["12px", "16px"],
        sm: ["14px", "20px"],
        base: ["15px", "22px"],
        lg: ["18px", "26px"],
        xl: ["22px", "28px"],
        "2xl": ["28px", "34px"],
      },
    },
  },
};

export default config;
