import { Moon, Sun } from "lucide-react";
import { useEffect, useState } from "react";
import type { Preferences } from "./types";

export function ThemeToggle({ theme, onChange }: {
  theme: Preferences["theme"];
  onChange: (theme: "light" | "dark") => void;
}) {
  const [systemDark, setSystemDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const dark = theme === "dark" || (theme === "system" && systemDark);
  return (
    <div className="theme-toggle" role="group" aria-label="深浅色切换">
      <button aria-label="切换到浅色" title="浅色模式" aria-pressed={!dark} onClick={() => onChange("light")}>
        <Sun size={16} strokeWidth={1.7} />
      </button>
      <button aria-label="切换到深色" title="深色模式" aria-pressed={dark} onClick={() => onChange("dark")}>
        <Moon size={16} strokeWidth={1.7} />
      </button>
    </div>
  );
}
