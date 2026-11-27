import React, { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Send,
  X,
  FileCode2,
  CheckCircle2,
  HelpCircle,
  AlertTriangle,
  CornerDownRight,
  Trash2,
  KeyRound,
  Volume2,
  VolumeX,
  Square,
  Loader2,
  PanelLeftClose,
  Plus,
  Pencil,
  FileJson,
  FileText,
} from 'lucide-react';
import type {
  ChatCitation,
  ChatContext,
  ChatMessage,
  ChatRecord,
  CodeAttachment,
} from '../types/codebase';
import {
  clearAudioCache,
  stopAllSpeech,
  synthesizeAndPlayAnswer,
  type PlaybackHandle,
  type VoiceEngineMode,
} from '../utils/speechAudio';

interface ChatPanelProps {
  repositoryName: string;
  onCollapse: () => void;
  messages: ChatMessage[];
  loading: boolean;
  context: ChatContext;
  hasCustomGeminiKey?: boolean;
  keyStatusError?: string;
  onQuickApplyGeminiKey?: (apiKey: string, retryQuestion?: string) => Promise<string | null>;
  onClearAttachedCode: () => void;
  onAttachCode: (att: CodeAttachment) => void;
  onSendMessage: (question: string) => void;
  onClearChat: () => void;
  chats: ChatRecord[];
  activeChatId: string | null;
  loadingChats: boolean;
  chatError: string | null;
  hasMoreMessages: boolean;
  loadingOlderMessages: boolean;
  onCreateChat: () => void;
  onSelectChat: (chatId: string) => void;
  onRenameChat: (chatId: string, title: string) => void;
  onDeleteChat: (chatId: string) => void;
  onExportChat: (chatId: string, format: 'json' | 'markdown') => void;
  onLoadOlderMessages: () => void;
  onOpenCitation: (filePath: string, startLine: number, endLine: number) => void;
  onTraceCode?: (codeText: string, citations?: ChatCitation[]) => Promise<boolean> | boolean;
}

const STARTER_QUESTIONS = [
  'What does this project do and how is it organized?',
  'Where does execution start?',
  'Explain the overall architecture and key modules.',
  'How do the main components communicate?',
];

const BARE_FILE_REF_RE =
  /((?:[a-zA-Z0-9_.-]+\/)*[a-zA-Z0-9_-]+\.(?:tsx|ts|jsx|js|mjs|cjs|py|json|yml|yaml|md|css|html|sql|sh|ps1|txt|toml|lock)(?::L?\d+(?:[-–]L?\d+)?)?)/g;

function renderCodeChip(
  codeText: string,
  key: React.Key,
  onTraceToken?: (token: string) => void
): React.ReactNode {
  if (onTraceToken) {
    return (
      <button
        key={key}
        type="button"
        onClick={() => onTraceToken(codeText)}
        title={`Click to trace "${codeText}" in code`}
        className="inline rounded bg-[#1A1F28] px-1 py-0.5 font-mono text-[11px] text-sky-300 underline decoration-sky-500/40 underline-offset-2 hover:bg-sky-500/20 hover:text-sky-200 hover:decoration-sky-400 transition-colors cursor-pointer text-left"
      >
        {codeText}
      </button>
    );
  }
  return (
    <code
      key={key}
      className="rounded bg-[#1A1F28] px-1 py-0.5 font-mono text-[11px] text-sky-300"
    >
      {codeText}
    </code>
  );
}

function renderPlainWithFileRefs(
  text: string,
  onTraceToken?: (token: string) => void
): React.ReactNode {
  if (!onTraceToken) return text;
  const parts = text.split(BARE_FILE_REF_RE);
  if (parts.length <= 1) return text;
  return parts.map((part, i) => {
    if (i % 2 === 1) {
      return (
        <button
          key={i}
          type="button"
          onClick={() => onTraceToken(part)}
          title={`Trace "${part}" in source code`}
          className="inline font-mono text-[11px] text-sky-400 underline decoration-sky-500/40 underline-offset-2 hover:text-sky-300 hover:decoration-sky-400 cursor-pointer text-left"
        >
          {part}
        </button>
      );
    }
    return <React.Fragment key={i}>{part}</React.Fragment>;
  });
}

function renderInlineFormatting(
  text: string,
  onTraceToken?: (token: string) => void
): React.ReactNode[] {
  // Safely render **bold** (including nested `code`), [label](url), and interactive `code`
  const tokens = text.split(/(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g);
  return tokens.map((tok, idx) => {
    if (tok.startsWith('**') && tok.endsWith('**') && tok.length > 4) {
      const inner = tok.slice(2, -2);
      const innerParts = inner.split(/(`[^`]+`)/g);
      return (
        <strong key={idx} className="font-semibold text-[#F3F4F6]">
          {innerParts.map((part, subIdx) =>
            part.startsWith('`') && part.endsWith('`') && part.length > 2
              ? renderCodeChip(part.slice(1, -1), `${idx}-${subIdx}`, onTraceToken)
              : <React.Fragment key={subIdx}>{renderPlainWithFileRefs(part, onTraceToken)}</React.Fragment>
          )}
        </strong>
      );
    }
    if (tok.startsWith('`') && tok.endsWith('`') && tok.length > 2) {
      return renderCodeChip(tok.slice(1, -1), idx, onTraceToken);
    }
    const linkMatch = tok.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
    if (linkMatch) {
      const label = linkMatch[1].replace(/^`|`$/g, '');
      const target = linkMatch[2].trim();
      if (/^https?:\/\//i.test(target)) {
        return (
          <a
            key={idx}
            href={target}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sky-400 underline underline-offset-2 hover:text-sky-300"
          >
            {label}
          </a>
        );
      }
      if (onTraceToken) {
        return (
          <button
            key={idx}
            type="button"
            onClick={() => onTraceToken(target || label)}
            title={`Trace "${label}" in source code`}
            className="inline font-mono text-[11px] text-sky-400 underline decoration-sky-500/40 underline-offset-2 hover:text-sky-300 hover:decoration-sky-400 cursor-pointer text-left"
          >
            {label}
          </button>
        );
      }
    }
    return <span key={idx}>{renderPlainWithFileRefs(tok, onTraceToken)}</span>;
  });
}

function SafeMarkdownBody({
  content,
  onTraceToken,
}: {
  content: string;
  onTraceToken?: (token: string) => void;
}) {
  const lines = content.split('\n');
  return (
    <div className="space-y-1.5 text-xs leading-relaxed text-[#D1D5DB]">
      {lines.map((raw, i) => {
        const line = raw.trimEnd();
        if (!line.trim()) return <div key={i} className="h-1" />;
        if (line.startsWith('### ')) {
          return (
            <h4 key={i} className="pt-1 text-xs font-semibold text-[#F3F4F6]">
              {renderInlineFormatting(line.slice(4), onTraceToken)}
            </h4>
          );
        }
        if (line.startsWith('## ') || line.startsWith('# ')) {
          return (
            <h3 key={i} className="pt-1.5 text-xs font-semibold text-[#F3F4F6]">
              {renderInlineFormatting(line.replace(/^#+\s*/, ''), onTraceToken)}
            </h3>
          );
        }
        if (line.trimStart().startsWith('- ') || line.trimStart().startsWith('* ')) {
          return (
            <div key={i} className="flex items-start gap-2 pl-1">
              <span className="mt-1.5 h-1 w-1 rounded-full bg-sky-400 shrink-0" />
              <span>{renderInlineFormatting(line.trimStart().slice(2), onTraceToken)}</span>
            </div>
          );
        }
        if (/^\d+\.\s+/.test(line.trimStart())) {
          const match = line.trimStart().match(/^(\d+\.)\s+(.*)$/);
          if (match) {
            return (
              <div key={i} className="flex items-start gap-2 pl-1">
                <span className="font-mono text-[11px] text-sky-400 shrink-0">{match[1]}</span>
                <span>{renderInlineFormatting(match[2], onTraceToken)}</span>
              </div>
            );
          }
        }
        return <p key={i}>{renderInlineFormatting(line, onTraceToken)}</p>;
      })}
    </div>
  );
}

export function ChatPanel({
  repositoryName,
  onCollapse,
  messages,
  loading,
  context,
  hasCustomGeminiKey,
  keyStatusError,
  onQuickApplyGeminiKey,
  onClearAttachedCode,
  onAttachCode,
  onSendMessage,
  onClearChat,
  chats,
  activeChatId,
  loadingChats,
  chatError,
  hasMoreMessages,
  loadingOlderMessages,
  onCreateChat,
  onSelectChat,
  onRenameChat,
  onDeleteChat,
  onExportChat,
  onLoadOlderMessages,
  onOpenCitation,
  onTraceCode,
}: ChatPanelProps) {
  const [input, setInput] = useState('');
  const [isDraggingOver, setIsDraggingOver] = useState(false);
  const [inlineKey, setInlineKey] = useState('');
  const [inlineSubmitting, setInlineSubmitting] = useState(false);
  const [inlineError, setInlineError] = useState<string | null>(null);
  const [autoRead, setAutoRead] = useState(false);
  const [voiceMode, setVoiceMode] = useState<VoiceEngineMode>('lite');
  const [speakingMessageId, setSpeakingMessageId] = useState<string | null>(null);
  const [speechState, setSpeechState] = useState<'idle' | 'loading' | 'playing'>('idle');
  const [speechEngineLabel, setSpeechEngineLabel] = useState<string>('');
  const [traceNotice, setTraceNotice] = useState<string | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);
  const previousScrollHeightRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const dragDepthRef = useRef(0);
  const traceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playbackHandleRef = useRef<PlaybackHandle | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  const lastAutoReadIdRef = useRef<string | null>(null);

  const handleTraceToken = async (token: string, citations?: ChatCitation[]) => {
    if (!onTraceCode) return;
    if (traceTimerRef.current) clearTimeout(traceTimerRef.current);
    const matched = await onTraceCode(token, citations);
    if (!matched) {
      setTraceNotice(`No exact source location found for "${token}"`);
      traceTimerRef.current = setTimeout(() => setTraceNotice(null), 2400);
    } else {
      setTraceNotice(null);
    }
  };

  const stopSpeaking = () => {
    abortControllerRef.current?.abort();
    abortControllerRef.current = null;
    playbackHandleRef.current?.stop();
    playbackHandleRef.current = null;
    stopAllSpeech(audioRef.current);
    audioRef.current = null;
    setSpeakingMessageId(null);
    setSpeechState('idle');
    setSpeechEngineLabel('');
  };

  const speakMessage = async (msg: ChatMessage, modeOverride?: VoiceEngineMode) => {
    if (!msg.content.trim() || msg.error) return;
    stopSpeaking();

    const controller = new AbortController();
    abortControllerRef.current = controller;
    setSpeakingMessageId(msg.id);

    const handle = await synthesizeAndPlayAnswer({
      messageId: msg.id,
      markdown: msg.content,
      mode: modeOverride ?? voiceMode,
      audioRef,
      signal: controller.signal,
      onLoading: () => {
        if (!controller.signal.aborted) {
          setSpeechState('loading');
          setSpeechEngineLabel('Preparing sweet voice...');
        }
      },
      onPlaying: (label) => {
        if (!controller.signal.aborted) {
          setSpeechState('playing');
          setSpeechEngineLabel(label);
        }
      },
      onEnded: () => {
        if (!controller.signal.aborted) {
          setSpeakingMessageId(null);
          setSpeechState('idle');
          setSpeechEngineLabel('');
        }
      },
      onError: () => {
        if (!controller.signal.aborted) {
          setSpeakingMessageId(null);
          setSpeechState('idle');
          setSpeechEngineLabel('');
        }
      },
    });

    if (controller.signal.aborted) {
      handle.stop();
    } else {
      playbackHandleRef.current = handle;
    }
  };

  useEffect(() => {
    const container = messagesContainerRef.current;
    const previousHeight = previousScrollHeightRef.current;
    if (container && previousHeight !== null) {
      container.scrollTop += container.scrollHeight - previousHeight;
      previousScrollHeightRef.current = null;
      return;
    }
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, loading]);

  useEffect(() => {
    if (!autoRead || messages.length === 0) return;
    const latest = messages[messages.length - 1];
    if (latest.role === 'assistant' && !latest.error && latest.id !== lastAutoReadIdRef.current) {
      lastAutoReadIdRef.current = latest.id;
      void speakMessage(latest);
    }
  }, [messages, autoRead]);

  useEffect(() => {
    const resetDrag = () => {
      dragDepthRef.current = 0;
      setIsDraggingOver(false);
    };
    window.addEventListener('dragend', resetDrag);
    return () => {
      window.removeEventListener('dragend', resetDrag);
      if (traceTimerRef.current) clearTimeout(traceTimerRef.current);
      abortControllerRef.current?.abort();
      playbackHandleRef.current?.stop();
      stopAllSpeech(audioRef.current);
      clearAudioCache();
    };
  }, []);

  const submitInput = () => {
    if (!input.trim() || loading) return;
    onSendMessage(input.trim());
    setInput('');
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    submitInput();
  };

  const hasSnippetPayload = (dt: DataTransfer | null): boolean =>
    Boolean(dt && Array.from(dt.types).includes('application/x-codebase-tutor-snippet'));

  const handleDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData('application/x-codebase-tutor-snippet');
    if (!raw && !hasSnippetPayload(e.dataTransfer)) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    dragDepthRef.current = 0;
    setIsDraggingOver(false);
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as CodeAttachment;
        if (parsed.file_path && parsed.code) {
          onAttachCode(parsed);
          textareaRef.current?.focus();
        }
      } catch {
        // ignore malformed drag payload
      }
    }
  };

  const activeContextParts: string[] = [];
  if (context.selectedFilePath) activeContextParts.push(context.selectedFilePath);
  if (context.selectedSymbolName) activeContextParts.push(context.selectedSymbolName);
  if (context.selectedNodeName) activeContextParts.push(`Node: ${context.selectedNodeName}`);

  return (
    <div
      className={`flex h-full flex-col bg-[#111419] border-r transition-colors ${
        isDraggingOver ? 'border-sky-500 ring-1 ring-inset ring-sky-500/50' : 'border-[#232832]'
      }`}
      onDragEnter={(e) => {
        if (hasSnippetPayload(e.dataTransfer)) {
          e.preventDefault();
          dragDepthRef.current += 1;
          setIsDraggingOver(true);
        }
      }}
      onDragOver={(e) => {
        if (hasSnippetPayload(e.dataTransfer)) {
          e.preventDefault();
          e.dataTransfer.dropEffect = 'copy';
          if (!isDraggingOver) setIsDraggingOver(true);
        }
      }}
      onDragLeave={(e) => {
        if (hasSnippetPayload(e.dataTransfer)) {
          dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
          if (dragDepthRef.current === 0) {
            setIsDraggingOver(false);
          }
        }
      }}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-[#232832] px-3.5 py-2.5">
        <div className="min-w-0">
          <h2 className="text-xs font-semibold text-[#E6E9EF]">Tutor Chat</h2>
          <p className="truncate text-[11px] text-[#6B7280]">
            Grounded in {repositoryName}
            {hasCustomGeminiKey ? ' · Custom Gemini key' : ''}
          </p>
          {keyStatusError && (
            <p className="text-[10px] text-amber-400">{keyStatusError}</p>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={onCollapse}
            title="Collapse Tutor Chat"
            aria-label="Collapse Tutor Chat"
            className="rounded p-1 text-[#6B7280] hover:bg-[#1A1F28] hover:text-[#E6E9EF] cursor-pointer"
          >
            <PanelLeftClose className="h-3.5 w-3.5" />
          </button>
          <button
            type="button"
            onClick={() => {
              const nextMode: VoiceEngineMode = voiceMode === 'lite' ? 'browser' : 'lite';
              setVoiceMode(nextMode);
              if (speakingMessageId) {
                stopSpeaking();
              }
            }}
            title={
              voiceMode === 'lite'
                ? 'Voice mode: Gemini Lite TTS (sweet voice, compacted & cached to save tokens). Click to switch to 0-token Browser Voice.'
                : 'Voice mode: Browser Sweet Voice (0 tokens). Click to switch to Gemini Lite TTS.'
            }
            className={`rounded border px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
              voiceMode === 'browser'
                ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-300'
                : 'border-[#232832] bg-[#161B24] text-[#9CA3AF] hover:text-sky-300'
            }`}
          >
            {voiceMode === 'browser' ? '0-tok' : 'Lite TTS'}
          </button>
          <button
            type="button"
            onClick={() => {
              const next = !autoRead;
              setAutoRead(next);
              if (!next && speakingMessageId) {
                stopSpeaking();
              }
            }}
            title={autoRead ? 'Auto-read answers: On (click to turn off)' : 'Auto-read answers: Off (click to read new answers automatically)'}
            className={`rounded p-1 transition-colors cursor-pointer ${
              autoRead
                ? 'bg-sky-500/15 text-sky-300'
                : 'text-[#6B7280] hover:bg-[#1A1F28] hover:text-[#E6E9EF]'
            }`}
          >
            {autoRead ? <Volume2 className="h-3.5 w-3.5" /> : <VolumeX className="h-3.5 w-3.5" />}
          </button>
          <Link
            to="/settings"
            title="Configure Gemini API key & GitHub credentials"
            className="rounded p-1 text-[#6B7280] hover:bg-[#1A1F28] hover:text-sky-300"
          >
            <KeyRound className="h-3.5 w-3.5" />
          </Link>
          {chats.length > 0 && (
            <button
              type="button"
              onClick={() => {
                stopSpeaking();
                if (window.confirm('Delete all chats for this repository?')) onClearChat();
              }}
              title="Delete all chats for this repository"
              className="rounded p-1 text-[#6B7280] hover:bg-[#1A1F28] hover:text-[#E6E9EF] cursor-pointer"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
      </div>

      <div className="flex items-center gap-1 border-b border-[#232832] px-2 py-1.5">
        <select
          aria-label="Select chat"
          value={activeChatId ?? ''}
          disabled={loadingChats || chats.length === 0}
          onChange={(event) => onSelectChat(event.target.value)}
          className="min-w-0 flex-1 rounded border border-[#232832] bg-[#0B0D10] px-2 py-1 text-[11px] text-[#D1D5DB] disabled:opacity-60"
        >
          <option value="" disabled>
            {loadingChats ? 'Loading chats...' : chats.length ? 'Select chat' : 'No saved chats'}
          </option>
          {chats.map((chat) => (
            <option key={chat.id} value={chat.id}>{chat.title}</option>
          ))}
        </select>
        <button
          type="button"
          onClick={onCreateChat}
          title="Start a new chat"
          aria-label="Start a new chat"
          className="rounded p-1 text-[#6B7280] hover:bg-[#1A1F28] hover:text-sky-300"
        >
          <Plus className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={!activeChatId}
          onClick={() => {
            const chat = chats.find((item) => item.id === activeChatId);
            if (!activeChatId || !chat) return;
            const title = window.prompt('Rename chat', chat.title)?.trim();
            if (title) onRenameChat(activeChatId, title);
          }}
          title="Rename chat"
          aria-label="Rename chat"
          className="rounded p-1 text-[#6B7280] hover:bg-[#1A1F28] hover:text-sky-300 disabled:opacity-40"
        >
          <Pencil className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={!activeChatId}
          onClick={() => activeChatId && onExportChat(activeChatId, 'json')}
          title="Export chat as JSON"
          aria-label="Export chat as JSON"
          className="rounded p-1 text-[#6B7280] hover:bg-[#1A1F28] hover:text-sky-300 disabled:opacity-40"
        >
          <FileJson className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={!activeChatId}
          onClick={() => activeChatId && onExportChat(activeChatId, 'markdown')}
          title="Export chat as Markdown"
          aria-label="Export chat as Markdown"
          className="rounded p-1 text-[#6B7280] hover:bg-[#1A1F28] hover:text-sky-300 disabled:opacity-40"
        >
          <FileText className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          disabled={!activeChatId}
          onClick={() => {
            if (activeChatId && window.confirm('Delete this chat?')) onDeleteChat(activeChatId);
          }}
          title="Delete this chat"
          aria-label="Delete this chat"
          className="rounded p-1 text-[#6B7280] hover:bg-[#1A1F28] hover:text-rose-300 disabled:opacity-40"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Active Workspace Focus Strip */}
      <div className="border-b border-[#232832] bg-[#0D1015] px-3.5 py-1.5 text-[11px] text-[#9CA3AF]">
        <div className="flex items-center gap-1.5 truncate">
          <CornerDownRight className="h-3 w-3 text-sky-400 shrink-0" />
          <span className="truncate">
            Focus: {activeContextParts.length > 0 ? activeContextParts.join(' · ') : 'Repository-wide'}
          </span>
        </div>
      </div>

      {/* Messages */}
      <div ref={messagesContainerRef} className="flex-1 overflow-y-auto px-3.5 py-3 space-y-4">
        {chatError && (
          <div role="alert" className="rounded border border-rose-500/30 bg-rose-500/10 p-2 text-[11px] text-rose-300">
            {chatError}
          </div>
        )}
        {hasMoreMessages && (
          <button
            type="button"
            disabled={loadingOlderMessages}
            onClick={() => {
              if (messagesContainerRef.current) {
                previousScrollHeightRef.current = messagesContainerRef.current.scrollHeight;
              }
              onLoadOlderMessages();
            }}
            className="w-full rounded border border-[#232832] px-2 py-1.5 text-[11px] text-[#9CA3AF] hover:text-[#E6E9EF] disabled:opacity-50"
          >
            {loadingOlderMessages ? 'Loading older messages...' : 'Load older messages'}
          </button>
        )}
        {messages.length === 0 ? (
          <div className="space-y-4 py-2">
            <div className="rounded-lg border border-[#232832] bg-[#0D1015] p-3.5 text-xs leading-relaxed text-[#9CA3AF]">
              Ask questions about <span className="font-medium text-[#E6E9EF]">{repositoryName}</span>, a selected file, a function block, or any node in the architecture diagrams. Explanations cite verified source lines.
            </div>

            <div className="space-y-1.5">
              <div className="text-[11px] font-medium text-[#6B7280]">Suggested questions</div>
              {STARTER_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => onSendMessage(q)}
                  className="block w-full rounded-md border border-[#232832] bg-[#141820] px-3 py-2 text-left text-xs text-[#D1D5DB] hover:border-sky-500/50 hover:text-[#F3F4F6] transition-colors cursor-pointer"
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        ) : (
          messages.map((msg) => (
            <div
              key={msg.id}
              className={`space-y-2 ${
                msg.role === 'user'
                  ? 'rounded-lg border border-[#262C38] bg-[#161B24] p-3'
                  : 'border-b border-[#232832]/60 pb-3'
              }`}
            >
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="font-semibold text-[#9CA3AF]">
                  {msg.role === 'user' ? 'You' : 'Codebase Tutor'}
                </span>
                {msg.role === 'assistant' && (
                  <div className="flex items-center gap-2 shrink-0">
                    {!msg.error && msg.content.trim() && (
                      <button
                        type="button"
                        onClick={() => {
                          if (speakingMessageId === msg.id) {
                            stopSpeaking();
                          } else {
                            void speakMessage(msg);
                          }
                        }}
                        title={
                          speakingMessageId === msg.id
                            ? speechEngineLabel || 'Stop reading'
                            : 'Read answer aloud (sweet low-token voice)'
                        }
                        className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap transition-colors cursor-pointer ${
                          speakingMessageId === msg.id
                            ? 'bg-sky-500/15 text-sky-300'
                            : 'text-[#9CA3AF] hover:bg-[#1A1F28] hover:text-sky-300'
                        }`}
                      >
                        {speakingMessageId === msg.id && speechState === 'loading' ? (
                          <>
                            <Loader2 className="h-3 w-3 animate-spin" />
                            <span>Loading</span>
                          </>
                        ) : speakingMessageId === msg.id && speechState === 'playing' ? (
                          <>
                            <Square className="h-2.5 w-2.5 fill-current" />
                            <span>Stop</span>
                          </>
                        ) : (
                          <>
                            <Volume2 className="h-3 w-3" />
                            <span>Listen</span>
                          </>
                        )}
                      </button>
                    )}
                    {msg.confidenceSummary && (
                      <span
                        className={`inline-flex items-center gap-1 ${
                          msg.confidenceSummary === 'verified'
                            ? 'text-emerald-400'
                            : msg.confidenceSummary === 'partial'
                              ? 'text-amber-400'
                              : 'text-[#9CA3AF]'
                        }`}
                      >
                        {msg.confidenceSummary === 'verified' ? (
                          <CheckCircle2 className="h-3 w-3" />
                        ) : msg.confidenceSummary === 'partial' ? (
                          <HelpCircle className="h-3 w-3" />
                        ) : (
                          <AlertTriangle className="h-3 w-3" />
                        )}
                        {msg.confidenceSummary === 'verified'
                          ? 'Evidence verified'
                          : msg.confidenceSummary === 'partial'
                            ? 'Partially verified'
                            : 'Insufficient evidence'}
                      </span>
                    )}
                  </div>
                )}
              </div>

              {msg.contextLabel && msg.role === 'user' && (
                <button
                  type="button"
                  onClick={() => void handleTraceToken(msg.contextLabel!)}
                  title="Click to jump to this context in code"
                  className="block max-w-full font-mono text-[10px] text-sky-400/90 hover:text-sky-300 hover:underline truncate cursor-pointer text-left"
                >
                  Context: {msg.contextLabel}
                </button>
              )}

              {msg.error ? (
                <div className="space-y-2.5 rounded border border-rose-500/30 bg-rose-500/10 p-2.5 text-xs text-rose-300">
                  <div>{msg.error}</div>
                  {(msg.error.includes('GEMINI_API_KEY') ||
                    msg.error.includes('API key') ||
                    msg.error.includes('Settings') ||
                    msg.error.includes('Gemini')) && (
                    <div className="space-y-2 border-t border-rose-500/20 pt-2">
                      {onQuickApplyGeminiKey && (
                        <form
                          onSubmit={async (e) => {
                            e.preventDefault();
                            if (!inlineKey.trim() || inlineSubmitting) return;
                            setInlineError(null);
                            setInlineSubmitting(true);
                            const prevUserMsg = [...messages]
                              .reverse()
                              .find((m) => m.role === 'user');
                            const errText = await onQuickApplyGeminiKey(
                              inlineKey.trim(),
                              prevUserMsg?.content
                            );
                            setInlineSubmitting(false);
                            if (errText) {
                              setInlineError(errText);
                            } else {
                              setInlineKey('');
                            }
                          }}
                          className="flex flex-col gap-1.5"
                        >
                          <div className="flex gap-1.5">
                            <input
                              type="password"
                              value={inlineKey}
                              onChange={(e) => setInlineKey(e.target.value)}
                              placeholder="Paste your Gemini API key (AIza...)"
                              className="min-w-0 flex-1 rounded border border-[#232832] bg-[#0B0D10] px-2.5 py-1 font-mono text-[11px] text-[#E6E9EF] placeholder-[#6B7280] focus:border-sky-500 focus:outline-none"
                            />
                            <button
                              type="submit"
                              disabled={inlineSubmitting || !inlineKey.trim()}
                              className="rounded bg-sky-500 px-2.5 py-1 text-[11px] font-semibold text-[#0B0D10] hover:bg-sky-400 disabled:opacity-40 whitespace-nowrap shrink-0 cursor-pointer"
                            >
                              {inlineSubmitting ? 'Verifying...' : 'Apply & Retry'}
                            </button>
                          </div>
                          {inlineError && (
                            <div className="text-[11px] text-rose-300">{inlineError}</div>
                          )}
                        </form>
                      )}
                      <Link
                        to="/settings"
                        className="inline-flex items-center gap-1.5 rounded border border-sky-500/40 bg-sky-500/15 px-2.5 py-1 text-[11px] font-medium text-sky-300 hover:bg-sky-500/25"
                      >
                        <KeyRound className="h-3 w-3" />
                        <span>Open Settings</span>
                      </Link>
                    </div>
                  )}
                </div>
              ) : msg.role === 'user' ? (
                <p className="text-xs leading-relaxed text-[#F3F4F6] whitespace-pre-wrap">{msg.content}</p>
              ) : (
                <SafeMarkdownBody
                  content={msg.content}
                  onTraceToken={
                    onTraceCode
                      ? (tok) => void handleTraceToken(tok, msg.citations)
                      : undefined
                  }
                />
              )}

              {msg.citations && msg.citations.length > 0 && (
                <div className="pt-1.5 space-y-1">
                  <div className="text-[10px] font-medium text-[#6B7280]">Source references</div>
                  <div className="flex flex-wrap gap-1.5">
                    {msg.citations.map((cit, idx) => (
                      <button
                        key={`${cit.file_path}-${idx}`}
                        type="button"
                        onClick={() => onOpenCitation(cit.file_path, cit.start_line, cit.end_line)}
                        className="inline-flex items-center gap-1 rounded border border-[#232832] bg-[#0B0D10] px-2 py-0.5 font-mono text-[10px] text-sky-400 hover:border-sky-500/60 hover:text-sky-300 transition-colors cursor-pointer"
                      >
                        <FileCode2 className="h-3 w-3 shrink-0" />
                        <span>
                          {cit.file_path}:L{cit.start_line}-{cit.end_line}
                        </span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </div>
          ))
        )}

        {loading && (
          <div className="rounded-lg border border-[#232832] bg-[#0D1015] px-3 py-2.5 text-xs text-[#9CA3AF]">
            Retrieving graph neighbors and source evidence...
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {/* Trace Feedback Notice */}
      {traceNotice && (
        <div className="mx-3 mb-2 rounded border border-[#232832] bg-[#0D1015] px-2.5 py-1 text-[11px] text-[#9CA3AF]">
          {traceNotice}
        </div>
      )}

      {/* Drag Drop Banner */}
      {isDraggingOver && (
        <div className="mx-3 mb-2 rounded-md border border-dashed border-sky-400/70 bg-sky-500/10 px-3 py-2 text-center text-[11px] font-medium text-sky-300">
          Drop code block here to attach to Tutor Chat
        </div>
      )}

      {/* Input Form */}
      <form
        onSubmit={handleSubmit}
        className={`border-t border-[#232832] p-3 transition-colors ${
          isDraggingOver ? 'bg-sky-500/10' : 'bg-[#0D1015]'
        }`}
      >
        <div className="relative rounded-md border border-[#232832] bg-[#0B0D10] focus-within:border-sky-500/60">
          {context.attachedCode && (
            <div className="border-b border-sky-500/30 bg-[#0D141F] p-2">
              <div className="mb-1 flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[10px] text-sky-300">
                  Attached:{' '}
                  {context.attachedCode.symbol_name ? `${context.attachedCode.symbol_name} · ` : ''}
                  {context.attachedCode.file_path}:L{context.attachedCode.start_line}-{context.attachedCode.end_line}
                </span>
                <button
                  type="button"
                  onClick={onClearAttachedCode}
                  className="shrink-0 text-[#9CA3AF] hover:text-[#F3F4F6] cursor-pointer"
                  title="Remove attachment"
                >
                  <X className="h-3 w-3" />
                </button>
              </div>
              <pre className="max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[10px] text-[#9CA3AF]">
                {context.attachedCode.code}
              </pre>
            </div>
          )}
          <textarea
            ref={textareaRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onDragOver={(e) => {
              if (hasSnippetPayload(e.dataTransfer)) {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }
            }}
            onDrop={handleDrop}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitInput();
              }
            }}
            placeholder={
              isDraggingOver
                ? 'Drop code block here to attach...'
                : 'Ask about this repo, file, function, or drag code here...'
            }
            className="w-full resize-none bg-transparent py-2 pl-3 pr-10 text-xs text-[#E6E9EF] placeholder-[#6B7280] focus:outline-none"
          />
          <button
            type="submit"
            disabled={loading || !input.trim()}
            aria-label="Send question"
            className="absolute bottom-2 right-2 rounded bg-sky-500 p-1.5 text-[#0B0D10] hover:bg-sky-400 disabled:opacity-40 disabled:cursor-not-allowed transition-colors cursor-pointer"
          >
            <Send className="h-3.5 w-3.5" />
          </button>
        </div>
      </form>
    </div>
  );
}
