"use client";

// 主题切换：亮 / 暗（Ivory Studio 语义 token 重映射，非机械反相）。
// - 初始值：localStorage 优先，其次 prefers-color-scheme，默认 light；
// - 写入 <html data-theme="...">，供 globals.css 的 [data-theme] 选择器消费；
// - 持久化到 localStorage；提供切换回调供按钮使用。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type Theme = "light" | "dark";

const STORAGE_KEY = "motro.theme";

function initialTheme(): Theme {
  if (typeof window === "undefined") return "light";
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored === "light" || stored === "dark") return stored;
  } catch {
    /* storage 不可用则回退系统偏好 */
  }
  if (typeof window.matchMedia === "function") {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)");
    if (prefersDark.matches) return "dark";
  }
  return "light";
}

interface ThemeContextValue {
  theme: Theme;
  toggle: () => void;
}

const ThemeContext = createContext<ThemeContextValue>({ theme: "light", toggle: () => {} });

export function ThemeProvider({ children }: { children: ReactNode }) {
  // Keep the server and first client render identical. The root inline script
  // paints the saved theme before hydration; we reconcile the React state in
  // the effect below instead of reading storage during render.
  const [theme, setTheme] = useState<Theme>("light");
  const hasMountedThemeEffect = useRef(false);

  useEffect(() => {
    const root = document.documentElement;
    const resolvedTheme = initialTheme();
    setTheme(resolvedTheme);
    root.setAttribute("data-theme", resolvedTheme);
    try {
      window.localStorage.setItem(STORAGE_KEY, resolvedTheme);
    } catch {
      /* 忽略 */
    }
  }, []);

  useEffect(() => {
    if (!hasMountedThemeEffect.current) {
      hasMountedThemeEffect.current = true;
      return;
    }
    document.documentElement.setAttribute("data-theme", theme);
  }, [theme]);

  const toggle = useCallback(() => {
    setTheme((t) => (t === "light" ? "dark" : "light"));
  }, []);

  return <ThemeContext.Provider value={{ theme, toggle }}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  return useContext(ThemeContext);
}
