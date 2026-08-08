import type React from "react";
import type { SecurityProvider } from "@/features/security/types";
import type { Locale, Translate, TranslationKey } from "@/i18n";
import type {
  QuickCommandGroup,
  QuickCommandItem,
  ResourceMonitorStatus,
  SessionResourceSnapshot,
  SftpProgress,
} from "@/types";

export type GroupMutationResult =
  | { ok: true; id?: string }
  | { ok: false; errorKey: TranslationKey };

export type FooterVisibility = {
  quickbar: boolean;
  statusbar: boolean;
};

export type TerminalStats = {
  windowRows: number;
  windowCols: number;
  bufferLines: number;
};

export type BottomAreaProps = {
  visibility: FooterVisibility;
  managerOpen: boolean;
  onOpenManager: () => void;
  showGroupTitle: boolean;
  groups: QuickCommandGroup[];
  commands: QuickCommandItem[];
  onCloseManager: () => void;
  onAddGroup: (name: string) => GroupMutationResult;
  onRenameGroup: (groupId: string, name: string) => GroupMutationResult;
  onRemoveGroup: (groupId: string) => void;
  onToggleGroupVisible: (groupId: string) => void;
  onAddCommand: (payload: {
    label: string;
    command: string;
    groupId?: string | null;
  }) => string | null;
  onUpdateCommand: (
    commandId: string,
    payload: Partial<QuickCommandItem>,
  ) => void;
  onReorderCommands: (groupId: string, commandIds: string[]) => void;
  onRemoveCommand: (commandId: string) => void;
  onShowGroupTitleChange: React.Dispatch<React.SetStateAction<boolean>>;
  onRunCommand: (command: string) => void;
  getActiveTerminalStats: () => TerminalStats;
  resourceMonitorEnabled: boolean;
  resourceMonitorStatus: ResourceMonitorStatus;
  resourceSnapshot: SessionResourceSnapshot | null;
  sftpProgressBySession: Record<string, SftpProgress>;
  onOpenTransfersWidget: () => void;
  activeAiConfigName: string | null;
  securityLocked: boolean;
  securityProvider: SecurityProvider;
  onSecurityAction: () => void;
  onLockScreen: () => void;
  locale: Locale;
  t: Translate;
};
