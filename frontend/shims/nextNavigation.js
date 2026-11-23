export function navigateTo(path, replace = false) {
  if (typeof window === "undefined") return;
  const target = path.startsWith("/") ? path : `/${path}`;
  if (replace) {
    window.location.replace(target);
  } else {
    window.location.href = target;
  }
}
