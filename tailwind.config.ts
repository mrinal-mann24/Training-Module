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
        // shadcn-style semantic tokens — hsl triplets defined in globals.css
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        border: "hsl(var(--border))",
        ring: "hsl(var(--ring))",

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
        // Legacy app tokens (chat/progress surfaces) — values repointed to the
        // current theme in globals.css so those components restyle themselves.
        "bg-canvas": "var(--bg-canvas)",
        "bg-surface": "var(--bg-surface)",
        "bg-surface-raised": "var(--bg-surface-raised)",
        "bg-user-bubble": "var(--bg-user-bubble)",
        "border-default": "var(--border-default)",
        "border-subtle": "var(--border-subtle)",
        "text-primary": "var(--text-primary)",
        "text-secondary": "var(--text-secondary)",
        "text-muted": "var(--text-muted)",
        "accent-hover": "var(--accent-hover)",
        "accent-subtle": "var(--accent-subtle)",
        "ai-thinking": "var(--ai-thinking)",
        "status-success": "#1F9254",
        "status-warning": "#B7791F",
        "status-error": "#D0342C",
        "status-info": "#6366F1",
      },
      borderRadius: {
        sm: "6px",
        md: "10px",
        lg: "16px",
        xl: "20px",
        full: "9999px",
      },
      fontFamily: {
        sans: ["Inter", "sans-serif"],
        body: ["Inter", "sans-serif"],
        display: ['"Instrument Serif"', "serif"],
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
      boxShadow: {
        dashboard: "var(--shadow-dashboard)",
      },
    },
  },
};

export default config;
