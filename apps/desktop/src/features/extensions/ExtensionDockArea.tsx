import {
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { X } from "lucide-react";
import type { DockGroupId, PresentationHome } from "@pideck/protocol";
import { MIN_EXTENSION_UI_DOCK_SIZE } from "@pideck/protocol";
import {
  canonicalExtensionUiSettings,
  notifyDesktopSettingsSaveFailure,
} from "../../lib/desktop-settings";
import {
  collectDockedPresentationSlots,
  partitionExtensionDockGroups,
  type DockedPresentationSlot,
} from "../../lib/extension-ui-dock-layout";
import {
  extensionUiFamilyMessageKey,
  extensionUiHomeMessageKey,
} from "../../lib/extension-ui-home-message";
import { observedExtensionDisplayName } from "../../lib/extension-ui-observation";
import {
  commitExtensionPresentationHome,
  commitExtensionUiSettings,
} from "../../lib/extension-ui-profile";
import { useLiveExtensionPresentationSlots } from "../../lib/extension-ui-live-slots";
import { useAppStore } from "../../lib/stores/app-store";
import { useT } from "../../lib/i18n/use-t";
import { ExtensionStatusRows, ExtensionWidgetRows } from "./ExtensionWidgetContent";
import {
  cancelExtensionTerminal,
  ExtensionTerminal,
  forceCloseExtensionTerminal,
} from "../dock/ExtensionTerminal";

function slotLabel(item: DockedPresentationSlot, translate: ReturnType<typeof useT>): string {
  const name = item.extensionId ? observedExtensionDisplayName(item.extensionId) : item.slotId;
  return `${name} ${translate(extensionUiFamilyMessageKey(item.family))}`;
}

async function persistSlotHome(
  item: DockedPresentationSlot,
  home: PresentationHome,
  message: string,
) {
  if (!item.extensionId) return;
  try {
    await commitExtensionPresentationHome({
      extensionId: item.extensionId,
      family: item.family,
      home,
      message,
    });
  } catch (error) {
    notifyDesktopSettingsSaveFailure(error);
  }
}

function nextDockHome(
  group: DockGroupId,
  items: readonly DockedPresentationSlot[],
): PresentationHome {
  return {
    kind: "dock",
    group,
    order: (items.at(-1)?.order ?? -1) + 1,
  };
}

export function ExtensionDockArea({ visible }: { visible: boolean }) {
  const t = useT();
  const slots = useLiveExtensionPresentationSlots();
  const settings = canonicalExtensionUiSettings(useAppStore((state) => state.desktopSettings));
  const docked = collectDockedPresentationSlots(slots);
  const { primary, secondary } = partitionExtensionDockGroups(docked);
  const direction = settings.dock.direction === "column" ? "column" : "row";
  const sizes = settings.dock.sizes ?? [0.5, 0.5];
  const [active, setActive] = useState<Partial<Record<DockGroupId, string>>>({});
  const [liveSizes, setLiveSizes] = useState<[number, number] | null>(null);
  const liveSizesRef = useRef<[number, number] | null>(null);
  const resize = useRef<{ pointerId: number; start: number; size: number } | null>(null);
  const displaySizes = liveSizes ?? sizes;

  const groups = useMemo(
    () => [
      { id: "primary" as const, items: primary },
      ...(secondary.length > 0 ? [{ id: "secondary" as const, items: secondary }] : []),
    ],
    [primary, secondary],
  );

  if (!visible || docked.length === 0) return null;

  const dropSlot = (event: ReactDragEvent, home: PresentationHome) => {
    event.preventDefault();
    event.stopPropagation();
    const slotId = event.dataTransfer.getData("application/x-pideck-extension-slot");
    const dragged = docked.find((candidate) => candidate.slotId === slotId);
    if (!dragged?.extensionId || (dragged.family !== "widget" && dragged.family !== "custom")) {
      return;
    }
    void persistSlotHome(
      dragged,
      home,
      t(extensionUiHomeMessageKey(home), {
        name: observedExtensionDisplayName(dragged.extensionId),
        family: t(extensionUiFamilyMessageKey(dragged.family)),
      }),
    );
  };

  const persistSizes = async (next: [number, number]) => {
    try {
      await commitExtensionUiSettings({
        next: {
          ...settings,
          dock: { ...settings.dock, secondaryEnabled: true, sizes: next },
        },
        previous: settings,
        message: t("extensionUiChangedHome", {
          name: t("extensionUiDockArea"),
          family: t("extensionUiSettingsGroup"),
        }),
      });
    } catch (error) {
      notifyDesktopSettingsSaveFailure(error);
    }
  };

  return (
    <div
      className={`flex min-h-0 flex-1 ${direction === "column" ? "flex-col" : "flex-row"}`}
      data-extension-dock-area
      data-extension-drop="dock-primary"
      aria-label={t("extensionUiDockArea")}
    >
      {groups.map((group, index) => {
        const selected = active[group.id] ?? group.items[0]?.slotId;
        return (
          <div
            key={group.id}
            className="flex min-h-0 min-w-0 flex-1 flex-col"
            data-extension-dock-group={group.id}
            style={
              groups.length === 2
                ? direction === "row"
                  ? { flexBasis: `${displaySizes[index] * 100}%` }
                  : { flexBasis: `${displaySizes[index] * 100}%` }
                : undefined
            }
          >
            {index === 1 && (
              <div
                role="separator"
                tabIndex={0}
                aria-orientation={direction === "row" ? "vertical" : "horizontal"}
                aria-valuemin={Math.round(MIN_EXTENSION_UI_DOCK_SIZE * 100)}
                aria-valuemax={80}
                aria-valuenow={Math.round(displaySizes[0] * 100)}
                className={
                  direction === "row"
                    ? "w-1 cursor-col-resize bg-border"
                    : "h-1 cursor-row-resize bg-border"
                }
                onPointerDown={(event: ReactPointerEvent<HTMLDivElement>) => {
                  event.currentTarget.setPointerCapture?.(event.pointerId);
                  resize.current = {
                    pointerId: event.pointerId,
                    start: direction === "row" ? event.clientX : event.clientY,
                    size: displaySizes[0],
                  };
                }}
                onPointerMove={(event) => {
                  if (!resize.current || resize.current.pointerId !== event.pointerId) return;
                  const delta =
                    (direction === "row" ? event.clientX : event.clientY) - resize.current.start;
                  const parent = event.currentTarget.parentElement?.parentElement;
                  const span = parent
                    ? direction === "row"
                      ? parent.clientWidth
                      : parent.clientHeight
                    : 400;
                  const next = Math.min(
                    0.8,
                    Math.max(MIN_EXTENSION_UI_DOCK_SIZE, resize.current.size + delta / span),
                  );
                  liveSizesRef.current = [next, 1 - next];
                  setLiveSizes(liveSizesRef.current);
                }}
                onPointerUp={() => {
                  const next = liveSizesRef.current;
                  resize.current = null;
                  liveSizesRef.current = null;
                  setLiveSizes(null);
                  if (next) void persistSizes(next);
                }}
                onKeyDown={(event) => {
                  const grow =
                    (direction === "row" && event.key === "ArrowRight") ||
                    (direction === "column" && event.key === "ArrowDown");
                  const shrink =
                    (direction === "row" && event.key === "ArrowLeft") ||
                    (direction === "column" && event.key === "ArrowUp");
                  if (!grow && !shrink) return;
                  event.preventDefault();
                  const nextPrimary = Math.min(
                    0.8,
                    Math.max(MIN_EXTENSION_UI_DOCK_SIZE, displaySizes[0] + (grow ? 0.05 : -0.05)),
                  );
                  const next: [number, number] = [nextPrimary, 1 - nextPrimary];
                  setLiveSizes(next);
                  liveSizesRef.current = next;
                  void persistSizes(next);
                }}
              />
            )}
            <div role="tablist" className="flex shrink-0 gap-1 border-b border-border px-2 pt-1">
              {group.items.map((item) => {
                const label = slotLabel(item, t);
                const name = item.extensionId
                  ? observedExtensionDisplayName(item.extensionId)
                  : item.slotId;
                const family = t(extensionUiFamilyMessageKey(item.family));
                return (
                  <div
                    key={item.slotId}
                    className={`flex max-w-48 min-w-0 items-center ${
                      selected === item.slotId
                        ? "border-b-2 border-accent text-foreground"
                        : "border-b-2 border-transparent text-muted"
                    }`}
                  >
                    <button
                      type="button"
                      role="tab"
                      aria-selected={selected === item.slotId}
                      data-extension-slot-tab={item.slotId}
                      className="min-w-0 flex-1 truncate px-2 py-1 text-left text-[11px]"
                      onClick={() =>
                        setActive((current) => ({ ...current, [group.id]: item.slotId }))
                      }
                      onKeyDown={(event) => {
                        if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
                        event.preventDefault();
                        const offset = event.key === "ArrowRight" ? 1 : -1;
                        const next =
                          group.items[
                            (group.items.findIndex(
                              (candidate) => candidate.slotId === item.slotId,
                            ) +
                              offset +
                              group.items.length) %
                              group.items.length
                          ];
                        if (next) {
                          setActive((current) => ({ ...current, [group.id]: next.slotId }));
                        }
                      }}
                      onDragOver={(event) => event.preventDefault()}
                      onDrop={(event) => dropSlot(event, nextDockHome(group.id, group.items))}
                    >
                      {label}
                    </button>
                    {item.family === "custom" && (
                      <button
                        type="button"
                        title={t("extensionUiFloatClose", { name, family })}
                        aria-label={t("extensionUiFloatClose", { name, family })}
                        className="mr-0.5 flex size-5 shrink-0 items-center justify-center rounded text-muted hover:text-foreground"
                        onClick={() => {
                          const panel = useAppStore.getState().extensionTerminal;
                          if (!panel) return;
                          void cancelExtensionTerminal(panel).then((error) => {
                            if (error) void forceCloseExtensionTerminal(panel);
                          });
                        }}
                      >
                        <X size={11} />
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
            <div className="min-h-0 flex-1 overflow-auto p-2">
              {group.items.map((item) => (
                <div
                  key={item.slotId}
                  role="tabpanel"
                  hidden={selected !== item.slotId}
                  data-extension-slot={item.slotId}
                  draggable={item.family === "widget" || item.family === "custom"}
                  onDragStart={(event) => {
                    event.dataTransfer.setData("application/x-pideck-extension-slot", item.slotId);
                  }}
                >
                  {item.mount.widgets?.length ? (
                    <ExtensionWidgetRows widgets={item.mount.widgets} />
                  ) : null}
                  {item.mount.statuses?.length ? (
                    <ExtensionStatusRows statuses={item.mount.statuses} />
                  ) : null}
                  {item.mount.custom ? (
                    <ExtensionTerminal visible={visible && selected === item.slotId} />
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {groups.length === 1 && (
        <div
          data-extension-drop="dock-secondary"
          data-extension-dock-edge="secondary"
          aria-label={t("extensionUiHomeDockSecondary")}
          className={direction === "row" ? "w-2 shrink-0" : "h-2 shrink-0"}
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => dropSlot(event, nextDockHome("secondary", []))}
        />
      )}
    </div>
  );
}
