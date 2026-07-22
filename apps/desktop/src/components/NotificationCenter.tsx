import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  AlertTriangle,
  Bell,
  CheckCircle2,
  Info,
  Trash2,
  X,
} from "lucide-react";
import { useAppStore, type AppNotification } from "../lib/stores/app-store";

function levelStyle(level: string) {
  switch (level) {
    case "error":
      return { icon: AlertCircle, color: "text-danger", label: "Error" };
    case "warning":
      return { icon: AlertTriangle, color: "text-warning", label: "Warning" };
    case "success":
      return { icon: CheckCircle2, color: "text-success", label: "Success" };
    default:
      return { icon: Info, color: "text-accent", label: "Information" };
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
}: {
  notifications: AppNotification[];
  onDismiss: (id: string) => void;
  onClear: () => void;
}) {
  return (
    <section
      role="dialog"
      aria-label="Notification center"
      className="fixed left-3 top-14 z-[70] flex max-h-[min(32rem,calc(100vh-4.25rem))] w-[min(25rem,calc(100vw-1.5rem))] flex-col overflow-hidden rounded-lg border border-border bg-surface-raised shadow-xl"
    >
      <header className="flex h-10 shrink-0 items-center border-b border-border px-3">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold">Notifications</h2>
        {notifications.length > 0 && (
          <button
            type="button"
            title="Clear all notifications"
            aria-label="Clear all notifications"
            onClick={onClear}
            className="flex size-7 items-center justify-center rounded text-muted hover:bg-surface-overlay hover:text-foreground"
          >
            <Trash2 size={14} />
          </button>
        )}
      </header>
      {notifications.length === 0 ? (
        <div className="flex min-h-28 items-center justify-center px-4 text-sm text-muted">
          No notifications
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
                  title="Dismiss notification"
                  aria-label="Dismiss notification"
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

export function NotificationCenter() {
  const notifications = useAppStore((state) => state.notifications);
  const dismissNotification = useAppStore((state) => state.dismissNotification);
  const clearNotifications = useAppStore((state) => state.clearNotifications);
  const [open, setOpen] = useState(false);
  const [toastId, setToastId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const previousLatestId = useRef<string | null>(null);
  const latest = notifications.at(-1) ?? null;

  useEffect(() => {
    if (!latest || latest.id === previousLatestId.current) return;
    previousLatestId.current = latest.id;
    setToastId(latest.id);
    const timer = window.setTimeout(() => setToastId(null), 6_000);
    return () => window.clearTimeout(timer);
  }, [latest?.id]);

  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      window.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  const toast = !open && toastId ? notifications.find((item) => item.id === toastId) : null;
  const urgentCount = notifications.filter(
    (notification) => notification.level === "error" || notification.level === "warning",
  ).length;

  return (
    <div ref={rootRef} className="relative z-[60]">
      <button
        type="button"
        title="Notifications"
        aria-label={`Notifications (${notifications.length})`}
        aria-expanded={open}
        onClick={() => {
          setOpen((value) => !value);
          setToastId(null);
        }}
        className={`relative flex size-8 items-center justify-center rounded-md text-muted transition-colors hover:bg-surface-overlay hover:text-foreground ${
          urgentCount > 0 ? "text-warning" : ""
        }`}
      >
        <Bell size={15} />
        {notifications.length > 0 && (
          <span className="absolute right-1.5 top-1 flex min-h-3 min-w-3 items-center justify-center rounded-full bg-danger px-0.5 text-[9px] leading-3 text-white">
            {notifications.length > 99 ? "99+" : notifications.length}
          </span>
        )}
      </button>

      {open && (
        <div>
          <NotificationPanel
            notifications={notifications}
            onDismiss={dismissNotification}
            onClear={clearNotifications}
          />
        </div>
      )}

      {toast && (
        <button
          type="button"
          aria-live="assertive"
          onClick={() => {
            setOpen(true);
            setToastId(null);
          }}
          className="fixed left-3 top-14 z-[70] flex w-[min(25rem,calc(100vw-1.5rem))] items-start gap-2 rounded-lg border border-border bg-surface-raised px-3 py-2.5 text-left shadow-xl"
        >
          {(() => {
            const style = levelStyle(toast.level);
            const Icon = style.icon;
            return <Icon size={16} aria-label={style.label} className={`mt-0.5 ${style.color}`} />;
          })()}
          <span className="min-w-0 flex-1 break-words text-sm leading-5">{toast.message}</span>
          <X
            size={14}
            aria-label="Dismiss notification preview"
            className="mt-0.5 shrink-0 text-muted"
            onClick={(event) => {
              event.stopPropagation();
              setToastId(null);
            }}
          />
        </button>
      )}
    </div>
  );
}
