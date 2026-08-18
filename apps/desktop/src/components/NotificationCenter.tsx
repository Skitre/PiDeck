import { useEffect, useRef, useState, type CSSProperties } from "react";
import { AlertCircle, AlertTriangle, Bell, CheckCircle2, Info, Trash2, X } from "lucide-react";
import { useT } from "../lib/i18n/use-t";
import { useAppStore, type AppNotification } from "../lib/stores/app-store";

export const NOTIFICATION_POPUP_WIDTH = 240;
export const NOTIFICATION_POPUP_MARGIN = 8;
export const NOTIFICATION_POPUP_GAP = 6;

export function notificationPopupLeft(
  bellCenterX: number,
  width = NOTIFICATION_POPUP_WIDTH,
  viewportWidth = 1280,
  margin = NOTIFICATION_POPUP_MARGIN,
): number {
  const centered = bellCenterX - width / 2;
  const maxLeft = viewportWidth - width - margin;
  return Math.round(Math.min(Math.max(margin, centered), Math.max(margin, maxLeft)));
}

export function notificationPopupTop(bellBottom: number, gap = NOTIFICATION_POPUP_GAP): number {
  return Math.round(bellBottom + gap);
}

function readPopupPosition(bell: HTMLElement | null): CSSProperties | null {
  if (!bell) return null;
  const rect = bell.getBoundingClientRect();
  const width = Math.min(
    NOTIFICATION_POPUP_WIDTH,
    Math.max(0, window.innerWidth - NOTIFICATION_POPUP_MARGIN * 2),
  );
  return {
    width,
    top: notificationPopupTop(rect.bottom),
    left: notificationPopupLeft(rect.left + rect.width / 2, width, window.innerWidth),
  };
}

function levelStyle(level: string) {
  switch (level) {
    case "error":
      return { icon: AlertCircle, color: "text-danger", accent: "border-l-danger", label: "Error" };
    case "warning":
      return {
        icon: AlertTriangle,
        color: "text-warning",
        accent: "border-l-warning",
        label: "Warning",
      };
    case "success":
      return {
        icon: CheckCircle2,
        color: "text-success",
        accent: "border-l-success",
        label: "Success",
      };
    default:
      return { icon: Info, color: "text-info", accent: "border-l-info", label: "Information" };
  }
}

function notificationTime(createdAt: number) {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(createdAt);
}

export function NotificationPanel({
  notifications,
  onDismiss,
  onClear,
  style,
}: {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
  onClear: () => void;
  style?: CSSProperties;
}) {
  const t = useT();
  return (
    <section
      role="dialog"
      aria-label={t("notifCenterTitle")}
      data-notification-panel
      style={style}
      className="theme-floating-surface fixed z-[70] flex max-h-[min(32rem,calc(100vh-4.25rem))] w-60 flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl"
    >
      <header className="flex h-10 shrink-0 items-center border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">{t("notifCenterTitle")}</h2>
        {notifications.length > 0 && (
          <button
            type="button"
            title={t("notifCenterClearAll")}
            aria-label={t("notifCenterClearAll")}
            onClick={onClear}
            className="flex size-7 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
          >
            <Trash2 size={14} />
          </button>
        )}
      </header>
      {notifications.length === 0 ? (
        <div className="flex min-h-28 items-center justify-center px-4 text-sm text-muted">
          {t("notifCenterEmpty")}
        </div>
      ) : (
        <ol className="min-h-0 overflow-y-auto">
          {[...notifications].reverse().map((notification) => {
            const style = levelStyle(notification.level);
            const Icon = style.icon;
            return (
              <li
                key={notification.id}
                className="flex gap-2.5 border-b border-border/70 px-3 py-2.5 last:border-b-0"
              >
                <Icon
                  size={16}
                  aria-label={style.label}
                  className={`mt-0.5 shrink-0 ${style.color}`}
                />
                <div className="min-w-0 flex-1">
                  <p className="break-words text-sm leading-5 text-foreground">
                    {notification.message}
                  </p>
                  <time
                    dateTime={new Date(notification.createdAt).toISOString()}
                    className="mt-1 block text-[11px] text-muted"
                  >
                    {notificationTime(notification.createdAt)}
                  </time>
                </div>
                <button
                  type="button"
                  title={t("notifCenterDismiss")}
                  aria-label={t("notifCenterDismiss")}
                  onClick={() => onDismiss(notification.id)}
                  className="flex size-7 shrink-0 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
                >
                  <X size={14} />
                </button>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}

const TOAST_DURATION_MS = 6_000;
const TOAST_LEAVE_MS = 200;
const MAX_STACKED_TOASTS = 3;

type ActiveToast = { id: string; leaving: boolean };

export function NotificationCenter() {
  const t = useT();
  const notifications = useAppStore((state) => state.notifications);
  const dismissNotification = useAppStore((state) => state.dismissNotification);
  const clearNotifications = useAppStore((state) => state.clearNotifications);
  const markNotificationsRead = useAppStore((state) => state.markNotificationsRead);
  const [open, setOpen] = useState(false);
  const [toasts, setToasts] = useState<ActiveToast[]>([]);
  const [popupStyle, setPopupStyle] = useState<CSSProperties>({
    width: NOTIFICATION_POPUP_WIDTH,
  });
  const rootRef = useRef<HTMLDivElement>(null);
  const bellRef = useRef<HTMLButtonElement>(null);
  const previousLatestId = useRef<string | null>(null);
  const toastTimers = useRef(new Map<string, number[]>());
  const latestId = notifications.at(-1)?.id ?? null;

  function clearToastTimers(id: string) {
    for (const timer of toastTimers.current.get(id) ?? []) window.clearTimeout(timer);
    toastTimers.current.delete(id);
  }

  function dismissAllToasts() {
    for (const id of toastTimers.current.keys()) {
      for (const timer of toastTimers.current.get(id) ?? []) window.clearTimeout(timer);
    }
    toastTimers.current.clear();
    setToasts([]);
  }

  useEffect(() => {
    if (!latestId || latestId === previousLatestId.current) return;
    previousLatestId.current = latestId;
    // The open panel already shows (and marks read) incoming notifications.
    if (open) return;
    syncPopupPosition();
    setToasts((current) =>
      [...current.filter((toast) => toast.id !== latestId), { id: latestId, leaving: false }].slice(
        -MAX_STACKED_TOASTS,
      ),
    );
    const leaveTimer = window.setTimeout(() => {
      setToasts((current) =>
        current.map((toast) => (toast.id === latestId ? { ...toast, leaving: true } : toast)),
      );
    }, TOAST_DURATION_MS - TOAST_LEAVE_MS);
    const removeTimer = window.setTimeout(() => {
      toastTimers.current.delete(latestId);
      setToasts((current) => current.filter((toast) => toast.id !== latestId));
    }, TOAST_DURATION_MS);
    toastTimers.current.set(latestId, [leaveTimer, removeTimer]);
  }, [latestId, open]);

  useEffect(
    () => () => {
      for (const timers of toastTimers.current.values()) {
        for (const timer of timers) window.clearTimeout(timer);
      }
    },
    [],
  );

  function syncPopupPosition() {
    const next = readPopupPosition(bellRef.current);
    if (next) setPopupStyle(next);
  }

  useEffect(() => {
    if (!open && toasts.length === 0) return;
    syncPopupPosition();
    window.addEventListener("resize", syncPopupPosition);
    return () => window.removeEventListener("resize", syncPopupPosition);
  }, [open, toasts.length]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      // A dialog or modal above us already acted on this Escape.
      if (event.key === "Escape" && !event.defaultPrevented) setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const unreadCount = notifications.filter((notification) => !notification.read).length;
  const urgentUnread = notifications.some(
    (notification) =>
      !notification.read && (notification.level === "error" || notification.level === "warning"),
  );

  useEffect(() => {
    if (open && unreadCount > 0) markNotificationsRead();
  }, [open, unreadCount, markNotificationsRead]);

  function openPanel() {
    syncPopupPosition();
    setOpen(true);
    markNotificationsRead();
    dismissAllToasts();
  }

  return (
    <>
      {/* Bell and panel sit below the Settings overlay (z-40) and modals (z-50);
        the toast stack is a sibling so its own z-[70] layer stays on top of both. */}
      <div ref={rootRef} className="relative z-30">
        <button
          ref={bellRef}
          type="button"
          title={t("notifCenterTitle")}
          aria-label={t("notifCenterLabel", { count: unreadCount })}
          aria-expanded={open}
          onClick={() => {
            if (open) {
              setOpen(false);
              return;
            }
            openPanel();
          }}
          className={`relative flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground ${
            urgentUnread ? "text-warning" : ""
          }`}
        >
          <Bell size={15} />
          {unreadCount > 0 && (
            <span className="absolute right-1.5 top-1 flex min-h-3 min-w-3 items-center justify-center rounded-full bg-danger px-0.5 text-[9px] leading-3 text-white">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </button>

        {open && (
          <div>
            <NotificationPanel
              notifications={notifications}
              onDismiss={dismissNotification}
              onClear={clearNotifications}
              style={popupStyle}
            />
          </div>
        )}
      </div>
      {!open && toasts.length > 0 && popupStyle.top != null && popupStyle.left != null && (
        <div
          role="status"
          aria-live="polite"
          style={popupStyle}
          className="pointer-events-none fixed z-[70] flex w-60 flex-col gap-2"
        >
          {toasts.map(({ id, leaving }) => {
            const notification = notifications.find((item) => item.id === id);
            if (!notification) return null;
            const style = levelStyle(notification.level);
            const Icon = style.icon;
            return (
              <button
                key={id}
                type="button"
                onClick={openPanel}
                className={`notification-toast theme-floating-surface pointer-events-auto flex items-start gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2.5 text-left shadow-xl border-l-2 ${style.accent} ${
                  leaving ? "notification-toast--leaving" : ""
                }`}
              >
                <Icon size={16} aria-label={style.label} className={`mt-0.5 ${style.color}`} />
                <span className="min-w-0 flex-1 break-words text-sm leading-5">
                  {notification.message}
                </span>
                <X
                  size={14}
                  aria-label={t("notifCenterDismissPreview")}
                  className="mt-0.5 shrink-0 text-muted"
                  onClick={(event) => {
                    event.stopPropagation();
                    clearToastTimers(id);
                    setToasts((current) => current.filter((toast) => toast.id !== id));
                  }}
                />
              </button>
            );
          })}
        </div>
      )}
    </>
  );
}
