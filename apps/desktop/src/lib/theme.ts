export function applyTheme(theme: "light" | "dark" | "system"): void {
  const root = document.documentElement;
  let effective: "light" | "dark" = "dark";
  if (theme === "system") {
    effective = window.matchMedia("(prefers-color-scheme: light)").matches
      ? "light"
      : "dark";
  } else {
    effective = theme;
  }
  root.classList.toggle("light", effective === "light");
  root.classList.toggle("dark", effective === "dark");
}
