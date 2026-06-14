import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { FileStream, getFiletypeFromFileName } from "@pierre/diffs";
import type { FileStreamOptions } from "@pierre/diffs";
import { PatchDiff } from "@pierre/diffs/react";
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/app-with-deps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./workspace-app.css";

type ToolName =
  | "open_workspace"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "grep_files"
  | "find_files"
  | "list_directory"
  | "run_shell"
  | "read"
  | "write"
  | "edit"
  | "grep"
  | "glob"
  | "ls"
  | "bash";

type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

interface ToolResultCard {
  tool: ToolName;
  workspaceId?: string;
  path?: string;
  root?: string;
  status?: string;
  summary?: Record<string, unknown>;
  payload?: ToolPayload;
  agentsFiles?: Array<{
    path?: string;
    content?: string;
  }>;
  availableAgentsFiles?: Array<{
    path?: string;
  }>;
  skills?: Array<{
    name?: string;
    description?: string;
    path?: string;
  }>;
  skillDiagnostics?: unknown[];
  instruction?: string;
}

interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

interface ToolPayload {
  content?: ToolContent[];
  diff?: string;
  patch?: string;
}

function isToolName(value: unknown): value is ToolName {
  return (
    value === "open_workspace" ||
    value === "read_file" ||
    value === "write_file" ||
    value === "edit_file" ||
    value === "grep_files" ||
    value === "find_files" ||
    value === "list_directory" ||
    value === "run_shell" ||
    value === "read" ||
    value === "write" ||
    value === "edit" ||
    value === "grep" ||
    value === "glob" ||
    value === "ls" ||
    value === "bash"
  );
}

function toolNameFromMeta(result: CallToolResult): ToolName | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  return isToolName(meta?.tool) ? meta.tool : undefined;
}

function isReadTool(tool: ToolName): boolean {
  return tool === "read_file" || tool === "read";
}

function isWriteTool(tool: ToolName): boolean {
  return tool === "write_file" || tool === "write";
}

function isEditTool(tool: ToolName): boolean {
  return tool === "edit_file" || tool === "edit";
}

function isSearchTool(tool: ToolName): boolean {
  return tool === "grep_files" || tool === "find_files" || tool === "grep" || tool === "glob";
}

function isShellTool(tool: ToolName): boolean {
  return tool === "run_shell" || tool === "bash";
}

function cardFromMeta(result: CallToolResult): Partial<ToolResultCard> | undefined {
  const meta = result._meta as Record<string, unknown> | undefined;
  const card = meta?.card;
  return card && typeof card === "object" ? card : undefined;
}

function isToolResultCard(value: unknown): value is Omit<ToolResultCard, "tool"> {
  return Boolean(value && typeof value === "object");
}

function getStructuredContent<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function AppRoot() {
  const appRef = useRef<App | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hostContext, setHostContext] = useState<HostContext | undefined>();
  const [card, setCard] = useState<ToolResultCard | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (appRef.current) return;

    const createdApp = new App(
      { name: "devspace-tool-cards", version: "0.3.0" },
      {},
    );
    appRef.current = createdApp;

    createdApp.ontoolresult = (result) => {
      const structuredContent = getStructuredContent<Partial<ToolResultCard>>(result);
      const metaCard = cardFromMeta(result);
      const structured = metaCard
        ? { ...structuredContent, ...metaCard }
        : structuredContent;
      const tool = toolNameFromMeta(result);
      if (!tool || !isToolResultCard(structured)) {
        setCard(null);
        setExpanded(false);
        setErrorMessage("No result card is available for this tool result.");
        return;
      }

      setCard({ ...structured, tool });
      setExpanded(false);
      setErrorMessage(null);
    };

    createdApp.onhostcontextchanged = (ctx) => {
      setHostContext((current: HostContext | undefined) => ({
        ...current,
        ...ctx,
      }));
    };

    createdApp.onteardown = async () => ({});

    void createdApp
      .connect()
      .then(() => {
        const initialContext = createdApp.getHostContext();
        if (initialContext) setHostContext(initialContext);
        setConnected(true);
      })
      .catch((connectError: unknown) => {
        setConnectionError(
          connectError instanceof Error
            ? connectError.message
            : String(connectError),
        );
      });
  }, []);

  useEffect(() => {
    if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
    if (hostContext?.styles?.variables) {
      applyHostStyleVariables(hostContext.styles.variables);
    }
    if (hostContext?.styles?.css?.fonts) {
      applyHostFonts(hostContext.styles.css.fonts);
    }

    const insets = hostContext?.safeAreaInsets;
    if (!insets) return;

    document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  }, [hostContext]);

  const themeType: "light" | "dark" =
    hostContext?.theme === "light" ? "light" : "dark";

  const fileOptions = useMemo(
    () => ({
      theme: {
        light: "pierre-light",
        dark: "pierre-dark",
      },
      themeType,
      overflow: "scroll" as const,
    }),
    [themeType],
  );

  const diffOptions = useMemo(
    () => ({
      theme: {
        light: "pierre-light",
        dark: "pierre-dark",
      },
      themeType,
      diffStyle: "unified" as const,
      diffIndicators: "bars" as const,
      hunkSeparators: "line-info" as const,
      lineDiffType: "word-alt" as const,
      overflow: "scroll" as const,
      collapsedContextThreshold: 4,
      expansionLineCount: 20,
      stickyHeader: true,
      disableFileHeader: true,
    }),
    [themeType],
  );

  const toggleExpanded = useCallback(() => {
    setExpanded((nextExpanded) => !nextExpanded);
  }, []);

  if (connectionError) return <EmptyState message={connectionError} tone="error" />;
  if (!connected) return <EmptyState message="Connecting to host..." />;
  if (!card) {
    return (
      <EmptyState
        message={errorMessage ?? "Waiting for a tool result."}
        tone={errorMessage ? "error" : "muted"}
      />
    );
  }

  const display = getToolDisplay(card);
  const expandable = isExpandableCard(card);

  return (
    <main className="shell">
      <section className={`tool-card ${display.tone}`}>
        <button
          className="tool-header"
          type="button"
          aria-expanded={expanded}
          disabled={!expandable}
          onClick={toggleExpanded}
        >
          <span className="tool-icon" aria-hidden="true">
            {display.icon}
          </span>
          <span className="tool-main">
            <span className="tool-title">{display.title}</span>
            <span className="tool-label" title={display.label}>
              {display.label}
            </span>
          </span>
          <SummaryBadges card={card} />
          <ChevronIcon expanded={expanded} visible={expandable} />
        </button>

        {expanded ? (
          <div className="tool-body">
            <ToolPayloadView
              card={card}
              errorMessage={errorMessage}
              fileOptions={fileOptions}
              diffOptions={diffOptions}
            />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function ToolPayloadView({
  card,
  errorMessage,
  fileOptions,
  diffOptions,
}: {
  card: ToolResultCard;
  errorMessage: string | null;
  fileOptions: FileStreamOptions;
  diffOptions: React.ComponentProps<typeof PatchDiff>["options"];
}) {
  if (errorMessage) {
    return <StatusLine message={errorMessage ?? "Unable to load details."} tone="error" />;
  }

  if (card.tool === "open_workspace") {
    return <WorkspacePayload card={card} />;
  }

  if (isEditTool(card.tool) || isWriteTool(card.tool)) {
    const patch = card.payload?.patch || card.payload?.diff;
    if (!patch) return <StatusLine message="Diff payload is not available." />;

    return <DiffPayload patch={patch} diffOptions={diffOptions} />;
  }

  const text = payloadText(card.payload);
  if (!text) return <StatusLine message="No details available." />;

  if (isReadTool(card.tool)) {
    return (
      <FilePayload
        path={card.path ?? "file"}
        text={text}
        startLine={summaryNumber(card.summary, "offset") ?? 1}
        fileOptions={fileOptions}
      />
    );
  }

  return <pre className={`text-payload ${card.tool}`}>{text}</pre>;
}

function WorkspacePayload({ card }: { card: ToolResultCard }) {
  const agentsFiles = card.agentsFiles ?? [];
  const availableAgentsFiles = card.availableAgentsFiles ?? [];
  const skills = card.skills ?? [];
  const lines = [
    card.workspaceId ? `Workspace: ${card.workspaceId}` : undefined,
    card.root ? `Root: ${card.root}` : undefined,
    skills.length > 0
      ? `Skills: ${skills.map((skill) => skill.name ?? skill.path ?? "unnamed").join(", ")}`
      : "Skills: none",
    availableAgentsFiles.length > 0
      ? `Nested instructions: ${availableAgentsFiles.map((file) => file.path ?? "unknown").join(", ")}`
      : undefined,
    agentsFiles.length > 0
      ? `\n${formatAgentsFilesForPayload(agentsFiles)}`
      : "\nAGENTS.md: none loaded",
  ].filter(Boolean);

  return <pre className="text-payload open_workspace">{lines.join("\n")}</pre>;
}

function formatAgentsFilesForPayload(
  agentsFiles: NonNullable<ToolResultCard["agentsFiles"]>,
): string {
  return agentsFiles
    .map((file) => {
      const path = file.path ?? "AGENTS.md";
      const content = file.content?.trim();
      return content ? `${path}\n\n${content}` : `${path}\n\nNo content loaded.`;
    })
    .join("\n\n");
}

function FilePayload({
  path,
  text,
  startLine,
  fileOptions,
}: {
  path: string;
  text: string;
  startLine: number;
  fileOptions: FileStreamOptions;
}) {
  const wrapperRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;

    const fileStream = new FileStream({
      ...fileOptions,
      lang: getFiletypeFromFileName(path),
      startingLineIndex: startLine,
    });
    const source = new ReadableStream<string>({
      start(controller) {
        controller.enqueue(text);
        controller.close();
      },
    });
    let disposed = false;

    void fileStream.setup(source, wrapper).then(() => {
      if (!disposed) return;
      fileStream.cleanUp();
      wrapper.replaceChildren();
    });

    return () => {
      disposed = true;
      fileStream.cleanUp();
      wrapper.replaceChildren();
    };
  }, [fileOptions, path, startLine, text]);

  return <div ref={wrapperRef} className="pierre-file" />;
}

function DiffPayload({
  patch,
  diffOptions,
}: {
  patch: string;
  diffOptions: React.ComponentProps<typeof PatchDiff>["options"];
}) {
  return (
    <PatchDiff
      patch={patch}
      options={diffOptions}
      className="pierre-diff"
    />
  );
}

function SummaryBadges({ card }: { card: ToolResultCard }) {
  const summary = card.summary ?? {};

  if (isEditTool(card.tool) || isWriteTool(card.tool)) {
    return (
      <span className="stats" aria-label="Diff statistics">
        <span className="add">+{String(summary.additions ?? 0)}</span>
        <span className="remove">-{String(summary.removals ?? 0)}</span>
      </span>
    );
  }

  if (card.tool === "open_workspace") {
    const agentsFiles = summaryNumber(summary, "agentsFiles") ?? 0;
    const skills = summaryNumber(summary, "skills") ?? 0;
    const agentsLabel = agentsFiles > 0 ? "AGENTS.md loaded" : "No AGENTS.md";
    return <span className="badge">{agentsLabel} · {skills} skills</span>;
  }

  if (isShellTool(card.tool)) {
    return <span className="badge">{String(summary.lines ?? 0)} lines</span>;
  }

  if (isSearchTool(card.tool)) {
    return <span className="badge">{String(summary.lines ?? 0)} lines</span>;
  }


  return <span className="badge">{String(summary.lines ?? 0)} lines</span>;
}

function isExpandableCard(card: ToolResultCard): boolean {
  if (card.tool === "open_workspace") {
    return (
      Number(card.summary?.agentsFiles ?? 0) > 0 ||
      Number(card.summary?.skills ?? 0) > 0 ||
      Number(card.summary?.skillDiagnostics ?? 0) > 0 ||
      Boolean(card.agentsFiles?.length) ||
      Boolean(card.availableAgentsFiles?.length) ||
      Boolean(card.skills?.length) ||
      Boolean(card.skillDiagnostics?.length)
    );
  }

  return Boolean(card.payload);
}

function getToolDisplay(card: ToolResultCard): {
  icon: ReactNode;
  title: string;
  label: string;
  tone: string;
} {
  const label = getToolLabel(card);

  switch (card.tool) {
    case "open_workspace":
      return { icon: <FolderIcon />, title: "Workspace", label, tone: "workspace" };
    case "read_file":
    case "read":
      return { icon: <FileIcon />, title: "Read File", label, tone: "read" };
    case "write_file":
    case "write":
      return { icon: <FilePlusIcon />, title: "Write File", label, tone: "write" };
    case "edit_file":
    case "edit":
      return { icon: <EditIcon />, title: "Edit File", label, tone: "edit" };
    case "grep_files":
    case "grep":
      return { icon: <SearchIcon />, title: "Grep", label, tone: "search" };
    case "find_files":
    case "glob":
      return { icon: <FilesIcon />, title: "Glob", label, tone: "search" };
    case "list_directory":
    case "ls":
      return { icon: <ListIcon />, title: "List Directory", label, tone: "directory" };
    case "run_shell":
    case "bash":
      return { icon: <TerminalIcon />, title: "Bash", label, tone: "shell" };
  }
}

function getToolLabel(card: ToolResultCard): string {
  if (isShellTool(card.tool)) {
    return String(card.summary?.command ?? card.path ?? card.tool);
  }
  if (card.path) return card.path;
  if (card.root) return card.root;
  if (isSearchTool(card.tool)) {
    return String(card.summary?.pattern ?? card.tool);
  }

  return card.tool;
}

function IconSvg({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <svg
      aria-hidden="true"
      className="icon-svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      {children}
    </svg>
  );
}

function ChevronIcon({
  expanded,
  visible,
}: {
  expanded: boolean;
  visible: boolean;
}) {
  if (!visible) return <span className="chevron" aria-hidden="true" />;

  return (
    <span className={`chevron ${expanded ? "expanded" : ""}`} aria-hidden="true">
      <IconSvg>
        <path d="m6 9 6 6 6-6" />
      </IconSvg>
    </span>
  );
}

function FolderIcon() {
  return (
    <IconSvg>
      <path d="M3 7.5h6l2 2h10" />
      <path d="M3 7.5v10A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5v-8H3" />
    </IconSvg>
  );
}

function FileIcon() {
  return (
    <IconSvg>
      <path d="M14 3v5h5" />
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </IconSvg>
  );
}

function FilePlusIcon() {
  return (
    <IconSvg>
      <path d="M14 3v5h5" />
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M12 12v6" />
      <path d="M9 15h6" />
    </IconSvg>
  );
}

function EditIcon() {
  return (
    <IconSvg>
      <path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </IconSvg>
  );
}

function SearchIcon() {
  return (
    <IconSvg>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </IconSvg>
  );
}

function FilesIcon() {
  return (
    <IconSvg>
      <path d="M8 7V4h9l4 4v10h-3" />
      <path d="M12 4v5h5" />
      <path d="M4 7h9l4 4v10H4z" />
      <path d="M13 7v5h4" />
    </IconSvg>
  );
}

function ListIcon() {
  return (
    <IconSvg>
      <path d="M8 6h12" />
      <path d="M8 12h12" />
      <path d="M8 18h12" />
      <path d="M4 6h.01" />
      <path d="M4 12h.01" />
      <path d="M4 18h.01" />
    </IconSvg>
  );
}

function TerminalIcon() {
  return (
    <IconSvg>
      <path d="m5 7 5 5-5 5" />
      <path d="M12 17h7" />
    </IconSvg>
  );
}

function payloadText(payload: ToolPayload | undefined): string {
  return (
    payload?.content
      ?.map((item) => {
        if (item.type === "text") return item.text ?? "";
        return `[${item.mimeType ?? "image"} image payload]`;
      })
      .filter(Boolean)
      .join("\n\n") ?? ""
  );
}

function summaryNumber(
  summary: Record<string, unknown> | undefined,
  key: string,
): number | undefined {
  const value = summary?.[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function EmptyState({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return (
    <main className="shell">
      <section className={`empty ${tone}`}>{message}</section>
    </main>
  );
}

function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return <div className={`status ${tone}`}>{message}</div>;
}

createRoot(document.querySelector("#app")!).render(<AppRoot />);
