import { canonicalExtensionUiSettings } from "./desktop-settings";
import {
  buildExtensionPresentationSlots,
  type ExtensionPresentationSlot,
  type LiveCustomContent,
  type LiveStatusContent,
  type LiveWidgetContent,
} from "./extension-ui-slots";
import { useAppStore } from "./stores/app-store";

export function useLiveExtensionPresentationSlots(): ExtensionPresentationSlot[] {
  useAppStore((state) => state.extensionWidgets);
  useAppStore((state) => state.extensionStatuses);
  useAppStore((state) => state.extensionStatusOrigins);
  useAppStore((state) => state.extensionTerminal);
  useAppStore((state) => state.desktopSettings);
  return liveExtensionPresentationSlots();
}

export function liveExtensionPresentationSlots(): ExtensionPresentationSlot[] {
  const state = useAppStore.getState();
  const widgets: LiveWidgetContent[] = Object.values(state.extensionWidgets).map((widget) => ({
    key: widget.key,
    widget: widget.widget,
    placement: widget.placement,
    origin: widget.origin,
  }));
  const statuses: LiveStatusContent[] = Object.entries(state.extensionStatuses).map(
    ([key, text]) => ({
      key,
      text,
      origin: state.extensionStatusOrigins[key],
    }),
  );
  const custom: LiveCustomContent | null = state.extensionTerminal
    ? {
        requestId: state.extensionTerminal.requestId,
        title: state.extensionTerminal.title,
        origin: state.extensionTerminal.origin,
        overlay: state.extensionTerminal.overlay,
      }
    : null;
  return buildExtensionPresentationSlots({
    settings: canonicalExtensionUiSettings(state.desktopSettings),
    widgets,
    statuses,
    custom,
  });
}
