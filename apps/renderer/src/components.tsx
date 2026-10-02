import { useState, type ReactNode, type RefObject } from "react";

import type {
  CharacterCardPreviewResponse,
  CharacterCardPreviewWarningCode,
  CharacterDetail,
  CharacterSummary,
} from "@mycompanion/shared";

export type ServiceState = "checking" | "online" | "offline";

export const stateText: Record<ServiceState, string> = {
  checking: "正在连接",
  online: "服务已连接",
  offline: "服务未连接",
};

export const warningText: Record<CharacterCardPreviewWarningCode, string> = {
  unknown_fields_preserved: "发现额外字段；系统会原样保留。",
  extensions_present: "角色卡包含扩展数据，请在确认导入前检查。",
  lorebook_stored_inactive:
    "世界书会随角色保存，之后可在世界书面板中选择启用。",
  regex_scripts_stored_disabled:
    "卡内正则会随角色保存，之后可在正则面板中选择启用。",
  v3_assets_not_imported: "卡片声明的外部资产不会自动下载；PNG 或 CHARX 内嵌文件可随卡片导入。",
  group_greetings_not_supported: "角色卡包含群聊开场白；单角色聊天暂不使用。",
  compatibility_defaults_applied:
    "部分社区卡字段缺失；系统将使用安全默认值，并保留原始数据。",
  legacy_format_converted: "旧格式会转换为 V2，原字段与未知字段保留；请检查预览。",
};

export function createIdempotencyKey(): string {
  return globalThis.crypto?.randomUUID?.() ??
    `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export function toSummary(character: CharacterDetail): CharacterSummary {
  return {
    ...(character.avatar ? { avatar: character.avatar } : {}),
    id: character.id,
    name: character.name,
    description: character.description,
    tags: character.tags,
    sourceFormat: character.sourceFormat,
    sourceVersion: character.sourceVersion,
    alternateGreetingsCount: character.alternateGreetingsCount,
    lorebookEntryCount: character.lorebookEntryCount,
    regexScriptCount: character.regexScriptCount,
    deletedAt: character.deletedAt,
    createdAt: character.createdAt,
    updatedAt: character.updatedAt,
  };
}

export function characterInitial(name: string): string {
  const characters = Array.from(name.trim());
  return (
    characters.find((character) => /[\p{L}\p{N}]/u.test(character)) ??
    characters[0] ??
    "?"
  ).toUpperCase();
}

export function CharacterAvatar({ character, large = false }: { character: Pick<CharacterSummary, "name" | "avatar" | "updatedAt">; large?: boolean }) {
  const source = character.avatar ? `/characters/${encodeURIComponent(character.avatar)}?v=${encodeURIComponent(character.updatedAt)}` : null;
  const [failedSource, setFailedSource] = useState<string | null>(null);
  return <span aria-hidden="true" className={`character-avatar${large ? " character-avatar--large" : ""}`}>{source && source !== failedSource ? <img alt="" src={source} onError={() => setFailedSource(source)} /> : characterInitial(character.name)}</span>;
}

const regexPlacementText: Record<string, string> = {
  markdown_display: "显示文本（旧版）",
  user_input: "用户输入",
  ai_output: "AI 输出",
  slash_command: "斜杠命令",
  world_info: "世界书",
  reasoning: "推理内容",
  unknown: "未知阶段",
};

export function placementText(value: string): string {
  return regexPlacementText[value] ??
    (value.startsWith("unknown:") ? `未知阶段 ${value.slice(8)}` : value);
}

export function RichTextPreview({ text }: { text: string }) {
  const looksLikeHtml = /<[a-z][\s\S]*>/i.test(text);
  return looksLikeHtml ? (
    <pre className="code-preview" aria-label="HTML 开场白源码"><code>{text}</code></pre>
  ) : (
    <blockquote>{text}</blockquote>
  );
}

export function ExpandableDescription({ text, emptyText }: { text: string; emptyText: string }) {
  if (!text) return <p>{emptyText}</p>;
  if (Array.from(text).length <= 240) return <p>{text}</p>;
  return (
    <details className="description-disclosure">
      <summary>{text.slice(0, 220)}… <span>展开完整简介</span></summary>
      <p>{text}</p>
    </details>
  );
}

export function ImportedContentDetails({
  lorebookEntries,
  regexScripts,
}: Pick<CharacterCardPreviewResponse, "lorebookEntries" | "regexScripts">) {
  return (
    <>
      {lorebookEntries.length > 0 ? (
        <details className="content-disclosure">
          <summary><span>世界书</span><small>{lorebookEntries.length} 条 · 已保存，运行时未启用</small></summary>
          <ol className="content-preview-list">
            {lorebookEntries.map((entry) => (
              <li key={`${entry.index}-${entry.name}`}>
                <div className="content-preview-heading"><strong>{entry.name}</strong><span>{entry.sourceEnabled ? "卡内启用" : "卡内停用"}</span></div>
                <p>{entry.contentPreview || "（空内容）"}</p>
                <dl><div><dt>关键词</dt><dd>{entry.keys.join("、") || "无"}</dd></div><div><dt>触发</dt><dd>{entry.constant ? "常驻" : entry.useRegex ? "正则关键词" : "普通关键词"}</dd></div><div><dt>顺序</dt><dd>{entry.insertionOrder}</dd></div></dl>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
      {regexScripts.length > 0 ? (
        <details className="content-disclosure">
          <summary><span>正则规则</span><small>{regexScripts.length} 条 · 导入后全部禁用</small></summary>
          <ol className="content-preview-list">
            {regexScripts.map((script) => (
              <li key={`${script.index}-${script.name}`}>
                <div className="content-preview-heading"><strong>{script.name}</strong><span className="status-disabled">已禁用</span></div>
                <code className="regex-source">{script.findRegexPreview || "（未提供查找表达式）"}</code>
                <dl><div><dt>卡内状态</dt><dd>{script.sourceDisabled ? "停用" : "启用"}</dd></div><div><dt>作用阶段</dt><dd>{script.placements.map(placementText).join("、") || "未声明"}</dd></div><div><dt>编辑时运行</dt><dd>{script.runOnEdit ? "是" : "否"}</dd></div></dl>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </>
  );
}

export type IconName =
  | "book"
  | "brain"
  | "character"
  | "chevron"
  | "download"
  | "file"
  | "history"
  | "plus"
  | "settings"
  | "sparkles"
  | "stop";

export function Icon({ name, size = 18 }: { name: IconName; size?: number }) {
  const paths: Record<IconName, ReactNode> = {
    book: <><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3H11v14H6.5A2.5 2.5 0 0 0 4 19.5z" /><path d="M20 5.5A2.5 2.5 0 0 0 17.5 3H13v14h4.5a2.5 2.5 0 0 1 2.5 2.5z" /></>,
    brain: <><path d="M9.5 4.5A3 3 0 0 0 4 6.2 3.5 3.5 0 0 0 3.8 12 3.3 3.3 0 0 0 8 16.8V19" /><path d="M14.5 4.5A3 3 0 0 1 20 6.2a3.5 3.5 0 0 1 .2 5.8 3.3 3.3 0 0 1-4.2 4.8V19M9.5 4.5V20M14.5 4.5V20M7 9h2.5M14.5 9H17M7.5 14h2M14.5 14h2" /></>,
    character: <><circle cx="12" cy="8" r="3.2" /><path d="M5.5 20c.5-4 2.7-6 6.5-6s6 2 6.5 6" /></>,
    chevron: <path d="m9 6 6 6-6 6" />,
    download: <><path d="M12 3v12m0 0 4-4m-4 4-4-4" /><path d="M5 19h14" /></>,
    file: <><path d="M6 3h8l4 4v14H6z" /><path d="M14 3v5h5" /></>,
    history: <><path d="M4 6v5h5" /><path d="M5.2 16.5A8 8 0 1 0 4 11" /><path d="M12 7v5l3 2" /></>,
    plus: <path d="M12 5v14M5 12h14" />,
    settings: <><circle cx="12" cy="12" r="3" /><path d="M19 13.5v-3l-2-.6a7 7 0 0 0-.7-1.6l1-1.9-2.1-2.1-1.9 1A7 7 0 0 0 11.5 5L11 3H8l-.6 2a7 7 0 0 0-1.6.7l-1.9-1-2.1 2.1 1 1.9A7 7 0 0 0 2 10.5l-2 .5v3l2 .6a7 7 0 0 0 .7 1.6l1 1.9 2.1 2.1 1.9-1a7 7 0 0 0 1.7.7l.6 2h3l.6-2a7 7 0 0 0 1.6-.7l1.9 1 2.1-2.1-1-1.9a7 7 0 0 0 .7-1.7z" transform="translate(2 -1) scale(.83)" /></>,
    sparkles: <><path d="m12 3 1.2 3.8L17 8l-3.8 1.2L12 13l-1.2-3.8L7 8l3.8-1.2z" /><path d="m18 14 .7 2.3L21 17l-2.3.7L18 20l-.7-2.3L15 17l2.3-.7zM5 13l.7 2.3L8 16l-2.3.7L5 19l-.7-2.3L2 16l2.3-.7z" /></>,
    stop: <rect height="11" rx="2" width="11" x="6.5" y="6.5" />,
  };

  return (
    <svg aria-hidden="true" className="ui-icon" fill="none" height={size} viewBox="0 0 24 24" width={size}>
      <g stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7">{paths[name]}</g>
    </svg>
  );
}

export function Metric({ label, value }: { label: string; value: number }) {
  return (
    <div className="metric">
      <strong>{value}</strong>
      <span>{label}</span>
    </div>
  );
}

export function Notice({ children, tone }: { children: ReactNode; tone: "error" | "success" }) {
  return (
    <div className={`notice notice--${tone}`} role={tone === "error" ? "alert" : "status"}>
      <span aria-hidden="true" className="notice__mark">
        {tone === "error" ? "!" : "✓"}
      </span>
      <div>{children}</div>
    </div>
  );
}

export type HeadingRef = RefObject<HTMLHeadingElement | null>;
export type MessageListRef = RefObject<HTMLDivElement | null>;
export type FileInputRef = RefObject<HTMLInputElement | null>;
