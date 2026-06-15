import { useEffect, useMemo, useRef, useState } from "react";
import { FiMenu } from "react-icons/fi";
import type { Translate } from "@/i18n";
import type { QuickCommandGroup, QuickCommandItem } from "@/types";
import Button from "@/components/ui/button";
import InputDialog from "@/components/ui/InputDialog";
import Modal from "@/components/ui/modal/Modal";
import Select from "@/components/ui/select";
import { DEFAULT_QUICKBAR_GROUP_ID } from "@/constants/quickbar";
import type { GroupMutationResult } from "@/main/components/bottom-area/BottomArea.types";
import {
  moveCommandId,
  resolveCommandLabel,
} from "@/main/components/bottom-area/quickbarUtils";

type QuickbarManagerModalProps = {
  open: boolean;
  showGroupTitle: boolean;
  sortedGroups: QuickCommandGroup[];
  commands: QuickCommandItem[];
  pendingFocusCommandId: string | null;
  onPendingFocusCommandHandled: () => void;
  onClose: () => void;
  onAddGroup: (name: string) => GroupMutationResult;
  onRenameGroup: (groupId: string, name: string) => GroupMutationResult;
  onRemoveGroup: (groupId: string) => void;
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
  t: Translate;
};

/** 快速命令管理弹窗。 */
export default function QuickbarManagerModal({
  open,
  showGroupTitle,
  sortedGroups,
  commands,
  pendingFocusCommandId,
  onPendingFocusCommandHandled,
  onClose,
  onAddGroup,
  onRenameGroup,
  onRemoveGroup,
  onAddCommand,
  onUpdateCommand,
  onReorderCommands,
  onRemoveCommand,
  onShowGroupTitleChange,
  t,
}: QuickbarManagerModalProps) {
  const [groupDialogMode, setGroupDialogMode] = useState<
    "add" | "rename" | null
  >(null);
  const [groupDialogError, setGroupDialogError] = useState<string | null>(null);
  const [deleteGroupPendingId, setDeleteGroupPendingId] = useState<
    string | null
  >(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string | null>(null);
  const [selectedCommandId, setSelectedCommandId] = useState<string | null>(
    null,
  );
  const [localPendingFocusCommandId, setLocalPendingFocusCommandId] = useState<
    string | null
  >(null);
  const [draggingCommandId, setDraggingCommandId] = useState<string | null>(
    null,
  );
  const [dragOverCommandId, setDragOverCommandId] = useState<string | null>(
    null,
  );
  const [previewCommandIds, setPreviewCommandIds] = useState<string[] | null>(
    null,
  );
  const commandLabelInputRef = useRef<HTMLInputElement | null>(null);
  const draggingCommandIdRef = useRef<string | null>(null);
  const suppressCommandClickRef = useRef<string | null>(null);

  const commandCountByGroup = useMemo(() => {
    const map = new Map<string, number>();
    commands.forEach((item) => {
      map.set(item.groupId, (map.get(item.groupId) ?? 0) + 1);
    });
    return map;
  }, [commands]);

  const managerGroupOptions = useMemo(
    () =>
      sortedGroups.map((group) => ({
        value: group.id,
        label: `${group.name} (${commandCountByGroup.get(group.id) ?? 0})`,
      })),
    [sortedGroups, commandCountByGroup],
  );

  const selectedGroup = useMemo(
    () => sortedGroups.find((group) => group.id === selectedGroupId) ?? null,
    [sortedGroups, selectedGroupId],
  );
  const deleteGroupPending = useMemo(
    () =>
      sortedGroups.find((group) => group.id === deleteGroupPendingId) ?? null,
    [sortedGroups, deleteGroupPendingId],
  );

  const groupCommands = useMemo(
    () => commands.filter((item) => item.groupId === selectedGroupId),
    [commands, selectedGroupId],
  );
  const previewGroupCommands = useMemo(() => {
    if (!previewCommandIds) return groupCommands;
    const commandById = new Map(groupCommands.map((item) => [item.id, item]));
    const previewCommands = previewCommandIds
      .map((id) => commandById.get(id))
      .filter((item): item is QuickCommandItem => Boolean(item));
    if (previewCommands.length !== groupCommands.length) return groupCommands;
    return previewCommands;
  }, [groupCommands, previewCommandIds]);

  const selectedCommand = useMemo(
    () => groupCommands.find((item) => item.id === selectedCommandId) ?? null,
    [groupCommands, selectedCommandId],
  );

  useEffect(() => {
    if (pendingFocusCommandId) {
      queueMicrotask(() => {
        setLocalPendingFocusCommandId(pendingFocusCommandId);
      });
    }
  }, [pendingFocusCommandId]);

  useEffect(() => {
    if (!groupDialogMode) {
      queueMicrotask(() => {
        setGroupDialogError(null);
      });
    }
  }, [groupDialogMode]);

  useEffect(() => {
    if (!open) return;
    if (!sortedGroups.length) {
      queueMicrotask(() => {
        setSelectedGroupId(null);
        setSelectedCommandId(null);
      });
      return;
    }
    const focusCommand = localPendingFocusCommandId
      ? (commands.find((item) => item.id === localPendingFocusCommandId) ??
        null)
      : null;
    if (focusCommand) {
      queueMicrotask(() => {
        setSelectedGroupId(focusCommand.groupId);
        setSelectedCommandId(focusCommand.id);
      });
      return;
    }
    const nextGroupId =
      selectedGroupId && sortedGroups.some((g) => g.id === selectedGroupId)
        ? selectedGroupId
        : sortedGroups[0].id;
    queueMicrotask(() => {
      setSelectedGroupId(nextGroupId);
    });
    const nextCommands = commands.filter(
      (item) => item.groupId === nextGroupId,
    );
    queueMicrotask(() => {
      setSelectedCommandId((prev) => {
        if (prev && nextCommands.some((item) => item.id === prev)) return prev;
        return nextCommands[0]?.id ?? null;
      });
    });
  }, [
    open,
    sortedGroups,
    commands,
    localPendingFocusCommandId,
    selectedGroupId,
  ]);

  useEffect(() => {
    if (!selectedGroupId) return;
    if (groupCommands.some((item) => item.id === selectedCommandId)) return;
    queueMicrotask(() => {
      setSelectedCommandId(groupCommands[0]?.id ?? null);
    });
  }, [selectedGroupId, groupCommands, selectedCommandId]);

  useEffect(() => {
    if (!open || !localPendingFocusCommandId) return;
    if (selectedCommand?.id !== localPendingFocusCommandId) return;
    const input = commandLabelInputRef.current;
    if (!input) return;
    input.focus();
    input.select();
    setLocalPendingFocusCommandId(null);
    onPendingFocusCommandHandled();
  }, [
    open,
    localPendingFocusCommandId,
    onPendingFocusCommandHandled,
    selectedCommand?.id,
  ]);

  function handleAddGroup() {
    setGroupDialogMode("add");
  }

  function handleRenameGroup() {
    if (!selectedGroup || selectedGroup.id === DEFAULT_QUICKBAR_GROUP_ID) {
      return;
    }
    setGroupDialogMode("rename");
  }

  function handleDeleteGroup() {
    if (!selectedGroup || selectedGroup.id === DEFAULT_QUICKBAR_GROUP_ID) {
      return;
    }
    setDeleteGroupPendingId(selectedGroup.id);
  }

  function handleAddCommand() {
    if (!selectedGroupId) return;
    const commandId = onAddCommand({
      label: t("quickbar.manager.newLabel"),
      command: "",
      groupId: selectedGroupId,
    });
    if (!commandId) return;
    setSelectedCommandId(commandId);
    setLocalPendingFocusCommandId(commandId);
  }

  function handleDeleteCommand() {
    if (!selectedCommandId) return;
    onRemoveCommand(selectedCommandId);
  }

  function handleCopyCommand() {
    if (!selectedCommand) return;
    onAddCommand({
      label: `${selectedCommand.label} ${t("quickbar.manager.copySuffix")}`,
      command: selectedCommand.command,
      groupId: selectedCommand.groupId,
    });
  }

  function clearCommandDragState() {
    draggingCommandIdRef.current = null;
    setDraggingCommandId(null);
    setDragOverCommandId(null);
    setPreviewCommandIds(null);
  }

  function handleCommandPointerDown(
    event: React.PointerEvent<HTMLButtonElement>,
    commandId: string,
  ) {
    if (event.button !== 0 || groupCommands.length < 2) return;
    event.preventDefault();
    const commandList = event.currentTarget.closest(".qm-command-list");
    if (!commandList) return;
    const activeCommandList = commandList;
    const commandIds = groupCommands.map((item) => item.id);
    let currentPreviewCommandIds = commandIds;
    const startX = event.clientX;
    const startY = event.clientY;
    let moved = false;
    let lastPreviewCommandIds = commandIds;

    function resolvePreviewCommandIds(clientY: number) {
      const items = Array.from(
        activeCommandList.querySelectorAll<HTMLElement>("[data-command-id]"),
      );
      const orderedIds = items
        .map((item) => item.dataset.commandId)
        .filter((id): id is string => Boolean(id && commandIds.includes(id)));
      const idsWithoutSource = orderedIds.filter((id) => id !== commandId);
      let insertIndex = idsWithoutSource.length;

      for (const item of items) {
        const itemCommandId = item.dataset.commandId;
        if (!itemCommandId || itemCommandId === commandId) continue;
        const rect = item.getBoundingClientRect();
        if (clientY < rect.top + rect.height / 2) {
          insertIndex = idsWithoutSource.indexOf(itemCommandId);
          break;
        }
      }

      return moveCommandId(orderedIds, commandId, insertIndex);
    }

    function cleanup() {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
      window.removeEventListener("blur", onPointerCancel);
      clearCommandDragState();
    }

    const onPointerMove = (moveEvent: PointerEvent) => {
      if (
        !moved &&
        (Math.abs(moveEvent.clientX - startX) > 4 ||
          Math.abs(moveEvent.clientY - startY) > 4)
      ) {
        moved = true;
        draggingCommandIdRef.current = commandId;
        setDraggingCommandId(commandId);
        setPreviewCommandIds(currentPreviewCommandIds);
      }
      if (!moved) return;
      const nextPreviewCommandIds = resolvePreviewCommandIds(moveEvent.clientY);
      if (
        nextPreviewCommandIds.join("\u0000") ===
        lastPreviewCommandIds.join("\u0000")
      ) {
        return;
      }
      lastPreviewCommandIds = nextPreviewCommandIds;
      currentPreviewCommandIds = nextPreviewCommandIds;
      setPreviewCommandIds(nextPreviewCommandIds);
      const sourceIndex = nextPreviewCommandIds.indexOf(commandId);
      const nextTargetCommandId =
        sourceIndex >= 0
          ? (nextPreviewCommandIds[sourceIndex + 1] ??
            nextPreviewCommandIds[sourceIndex - 1] ??
            null)
          : null;
      setDragOverCommandId(nextTargetCommandId);
    };

    const onPointerUp = () => {
      cleanup();
      if (!moved) return;
      suppressCommandClickRef.current = commandId;
      if (
        !selectedGroupId ||
        currentPreviewCommandIds.join("\u0000") === commandIds.join("\u0000")
      ) {
        return;
      }
      onReorderCommands(selectedGroupId, currentPreviewCommandIds);
    };

    const onPointerCancel = () => cleanup();
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp, { once: true });
    window.addEventListener("pointercancel", onPointerCancel, { once: true });
    window.addEventListener("blur", onPointerCancel, { once: true });
  }

  return (
    <>
      <Modal
        open={open}
        title={t("quickbar.manager.title")}
        closeLabel={t("actions.close")}
        onClose={onClose}
      >
        <div className="quickbar-manager">
          <section className="qm-top">
            <Select
              value={selectedGroupId}
              options={managerGroupOptions}
              placeholder={t("quickbar.manager.selectGroup")}
              onChange={(value) => setSelectedGroupId(value || null)}
              aria-label={t("quickbar.manager.group")}
            />
            <Button variant="ghost" size="sm" onClick={handleAddGroup}>
              {t("quickbar.manager.addGroup")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={
                !selectedGroup || selectedGroup.id === DEFAULT_QUICKBAR_GROUP_ID
              }
              onClick={handleDeleteGroup}
            >
              {t("quickbar.manager.deleteGroup")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={
                !selectedGroup || selectedGroup.id === DEFAULT_QUICKBAR_GROUP_ID
              }
              onClick={handleRenameGroup}
            >
              {t("quickbar.manager.renameGroup")}
            </Button>
          </section>

          <section className="qm-left">
            <div className="qm-title">{t("quickbar.manager.commandList")}</div>
            <div
              className="qm-command-list"
              data-ui="quickbar-manager-command-list"
            >
              {previewGroupCommands.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  data-ui="quickbar-manager-command-item"
                  data-command-id={item.id}
                  className={`qm-command-item ${selectedCommandId === item.id ? "active" : ""} ${
                    draggingCommandId === item.id ? "dragging" : ""
                  } ${dragOverCommandId === item.id ? "drag-over" : ""}`.trim()}
                  onClick={() => {
                    if (suppressCommandClickRef.current === item.id) {
                      suppressCommandClickRef.current = null;
                      return;
                    }
                    setSelectedCommandId(item.id);
                  }}
                  onPointerDown={(event) =>
                    handleCommandPointerDown(event, item.id)
                  }
                >
                  <FiMenu className="qm-command-drag-handle" aria-hidden />
                  <span className="qm-command-label">
                    {resolveCommandLabel(item, t)}
                  </span>
                </button>
              ))}
              {!groupCommands.length && (
                <div className="qm-empty">
                  {t("quickbar.manager.emptyGroup")}
                </div>
              )}
            </div>
            <div className="qm-left-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={!selectedGroupId}
                onClick={handleAddCommand}
              >
                {t("quickbar.manager.addCommand")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!selectedCommandId}
                onClick={handleDeleteCommand}
              >
                {t("quickbar.manager.deleteCommand")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={!selectedCommandId}
                onClick={handleCopyCommand}
              >
                {t("quickbar.manager.copyCommand")}
              </Button>
            </div>
          </section>

          <section className="qm-right">
            <div className="qm-title">{t("quickbar.manager.detail")}</div>
            {selectedCommand ? (
              <div className="qm-detail-form">
                <label>
                  <span>{t("quickbar.manager.commandLabel")}</span>
                  <input
                    ref={commandLabelInputRef}
                    value={selectedCommand.label}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) =>
                      onUpdateCommand(selectedCommand.id, {
                        label: event.target.value,
                      })
                    }
                    onBlur={(event) => {
                      if (event.target.value.trim()) return;
                      onUpdateCommand(selectedCommand.id, {
                        label: t("quickbar.manager.newLabel"),
                      });
                    }}
                  />
                </label>
                <label>
                  <span>{t("quickbar.manager.commandType")}</span>
                  <Select
                    value="sendText"
                    options={[
                      {
                        value: "sendText",
                        label: t("quickbar.manager.sendText"),
                      },
                    ]}
                    disabled
                    onChange={() => {}}
                    aria-label={t("quickbar.manager.commandType")}
                  />
                </label>
                <label>
                  <span>{t("quickbar.manager.commandText")}</span>
                  <textarea
                    value={selectedCommand.command}
                    autoComplete="off"
                    autoCorrect="off"
                    spellCheck={false}
                    onChange={(event) =>
                      onUpdateCommand(selectedCommand.id, {
                        command: event.target.value,
                      })
                    }
                  />
                </label>
              </div>
            ) : (
              <div className="qm-empty">
                {t("quickbar.manager.noCommandSelected")}
              </div>
            )}
          </section>

          <section className="qm-bottom">
            <label className="qm-option">
              <input
                type="checkbox"
                autoComplete="off"
                checked={showGroupTitle}
                onChange={(event) =>
                  onShowGroupTitleChange(event.target.checked)
                }
              />
              <span>{t("quickbar.manager.showGroupTitle")}</span>
            </label>
          </section>
        </div>
      </Modal>

      <InputDialog
        open={groupDialogMode !== null}
        title={
          groupDialogMode === "add"
            ? t("quickbar.manager.addGroup")
            : t("quickbar.manager.renameGroup")
        }
        label={t("quickbar.manager.group")}
        placeholder={t("quickbar.manager.groupPlaceholder")}
        initialValue={
          groupDialogMode === "rename" ? (selectedGroup?.name ?? "") : ""
        }
        confirmText={t("actions.save")}
        cancelText={t("actions.cancel")}
        closeText={t("actions.close")}
        errorText={groupDialogError}
        onClose={() => {
          setGroupDialogMode(null);
          setGroupDialogError(null);
        }}
        onValueChange={() => setGroupDialogError(null)}
        onConfirm={(value) => {
          const name = value.trim();
          if (!name) {
            setGroupDialogError(t("quickbar.manager.groupNameRequired"));
            return;
          }
          if (groupDialogMode === "add") {
            const result = onAddGroup(name);
            if (!result.ok) {
              setGroupDialogError(t(result.errorKey));
              return;
            }
            if (result.id) {
              setSelectedGroupId(result.id);
              setSelectedCommandId(null);
            }
          } else if (groupDialogMode === "rename" && selectedGroup) {
            const result = onRenameGroup(selectedGroup.id, name);
            if (!result.ok) {
              setGroupDialogError(t(result.errorKey));
              return;
            }
          }
          setGroupDialogError(null);
          setGroupDialogMode(null);
        }}
      />

      <Modal
        open={!!deleteGroupPending}
        title={t("quickbar.manager.deleteGroup")}
        closeLabel={t("actions.close")}
        onClose={() => setDeleteGroupPendingId(null)}
        actions={
          <>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setDeleteGroupPendingId(null)}
            >
              {t("actions.cancel")}
            </Button>
            <Button
              variant="danger"
              size="sm"
              onClick={() => {
                if (!deleteGroupPending) return;
                onRemoveGroup(deleteGroupPending.id);
                setDeleteGroupPendingId(null);
              }}
            >
              {t("actions.remove")}
            </Button>
          </>
        }
      >
        <p className="qm-delete-confirm">
          {deleteGroupPending
            ? t("quickbar.manager.deleteGroupConfirm", {
                name: deleteGroupPending.name,
              })
            : ""}
        </p>
      </Modal>
    </>
  );
}
