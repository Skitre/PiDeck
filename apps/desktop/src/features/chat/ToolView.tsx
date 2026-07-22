import type { ComponentType } from "react";
import {
  FileMutationToolCard,
  FileReadToolCard,
  isFileMutationTool,
  isFileReadTool,
  isShellTool,
  ShellToolCard,
} from "./CodingToolCards";
import { SearchToolCard, isWebSearchTool } from "./SearchToolCard";
import { ToolCard, useToolDisclosure, type ToolCardProps } from "./ToolCard";

export type ToolRendererDefinition = {
  id: string;
  matches: (props: ToolCardProps) => boolean;
  Component: ComponentType<ToolCardProps>;
};

export const toolRenderers: ToolRendererDefinition[] = [
  {
    id: "web-search",
    matches: (props) => isWebSearchTool(props.name),
    Component: SearchToolCard,
  },
  {
    id: "file-read",
    matches: (props) => isFileReadTool(props.name),
    Component: FileReadToolCard,
  },
  {
    id: "shell",
    matches: (props) => isShellTool(props.name),
    Component: ShellToolCard,
  },
  {
    id: "file-mutation",
    matches: (props) => isFileMutationTool(props.name),
    Component: FileMutationToolCard,
  },
];

export function selectToolRenderer(props: ToolCardProps): ToolRendererDefinition | undefined {
  return toolRenderers.find((renderer) => renderer.matches(props));
}

export function ToolView(props: ToolCardProps) {
  const [expanded, setExpanded] = useToolDisclosure(props);
  const rendererProps: ToolCardProps = {
    ...props,
    expanded,
    onExpandedChange: setExpanded,
  };
  // Mixed provider blocks need one ordered result surface. Specialized cards
  // consume flattened text, so use the generic card when rich blocks exist.
  if (props.resultContent !== undefined) return <ToolCard {...rendererProps} />;
  const renderer = selectToolRenderer(props);
  if (!renderer) return <ToolCard {...rendererProps} />;
  const Renderer = renderer.Component;
  return <Renderer {...rendererProps} />;
}
