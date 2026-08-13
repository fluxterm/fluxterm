/** 串口 Profile 分组管理 Widget。 */
import { useMemo, useState } from "react";
import {
  FiCpu,
  FiEdit2,
  FiFolder,
  FiFolderPlus,
  FiLoader,
  FiPlay,
  FiPlus,
  FiTrash2,
  FiX,
} from "react-icons/fi";
import Button from "@/components/ui/button";
import InputDialog from "@/components/ui/InputDialog";
import ContextMenu, {
  type ContextMenuItem,
} from "@/components/ui/menu/ContextMenu";
import Modal from "@/components/ui/modal/Modal";
import Select from "@/components/ui/select";
import { ROOT_PROFILE_GROUP_VALUE } from "@/constants/hostGroups";
import type { Translate } from "@/i18n";
import type { SerialProfile } from "@/types";
import "@/widgets/serial/components/SerialWidget.css";

const GROUP_NAME_MAX_LENGTH = 12;

type SerialWidgetProps = {
  profiles: SerialProfile[];
  groups: string[];
  activeProfileId: string | null;
  connectingProfileIds: string[];
  onPick: (profileId: string) => void;
  onConnect: (profile: SerialProfile) => void;
  onCancelConnect: (profileId: string) => void;
  onOpenNewProfile: (defaultGroup?: string | null) => void;
  onOpenEditProfile: (profile: SerialProfile) => void;
  onRemoveProfile: (profile: SerialProfile) => void;
  onSaveGroups: (groups: string[]) => Promise<string[]>;
  onMoveProfileToGroup: (
    profileId: string,
    targetGroup: string | null,
  ) => Promise<boolean>;
  t: Translate;
};

/** 规范化并去重分组名称。 */
function normalizeGroups(groups: string[]) {
  const result: string[] = [];
  groups.forEach((value) => {
    const name = value.trim();
    if (
      !name ||
      result.some((item) => item.toLowerCase() === name.toLowerCase())
    ) {
      return;
    }
    result.push(name);
  });
  return result;
}

/** 渲染与 SSH/RDP 一致的串口配置树。 */
export default function SerialWidget({
  profiles,
  groups,
  activeProfileId,
  connectingProfileIds,
  onPick,
  onConnect,
  onCancelConnect,
  onOpenNewProfile,
  onOpenEditProfile,
  onRemoveProfile,
  onSaveGroups,
  onMoveProfileToGroup,
  t,
}: SerialWidgetProps) {
  const [query, setQuery] = useState("");
  const [expandedGroups, setExpandedGroups] = useState<Set<string>>(
    () => new Set(),
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    items: ContextMenuItem[];
  } | null>(null);
  const [groupDialog, setGroupDialog] = useState<{
    mode: "add" | "rename";
    source?: string;
  } | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [moveProfile, setMoveProfile] = useState<SerialProfile | null>(null);
  const [moveTarget, setMoveTarget] = useState(ROOT_PROFILE_GROUP_VALUE);
  const [removeGroup, setRemoveGroup] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const connecting = useMemo(
    () => new Set(connectingProfileIds),
    [connectingProfileIds],
  );
  const normalizedQuery = query.trim().toLowerCase();
  const groupEntries = useMemo(() => {
    const map = new Map<string, { label: string; profiles: SerialProfile[] }>();
    groups.forEach((group) => {
      const label = group.trim();
      if (label) map.set(label.toLowerCase(), { label, profiles: [] });
    });
    profiles.forEach((profile) => {
      const label = profile.tags?.[0]?.trim();
      if (!label) return;
      const key = label.toLowerCase();
      const entry = map.get(key) ?? { label, profiles: [] };
      entry.profiles.push(profile);
      map.set(key, entry);
    });
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [groups, profiles]);
  const filteredGroups = groupEntries
    .map((group) => ({
      ...group,
      profiles: group.profiles.filter((profile) =>
        `${profile.name} ${profile.portName}`
          .toLowerCase()
          .includes(normalizedQuery),
      ),
    }))
    .filter(
      (group) =>
        !normalizedQuery ||
        group.label.toLowerCase().includes(normalizedQuery) ||
        group.profiles.length > 0,
    );
  const rootProfiles = profiles.filter(
    (profile) =>
      !profile.tags?.[0]?.trim() &&
      `${profile.name} ${profile.portName}`
        .toLowerCase()
        .includes(normalizedQuery),
  );

  function openMenu(event: React.MouseEvent, items: ContextMenuItem[]) {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, items });
  }

  async function persistGroups(next: string[]) {
    setBusy(true);
    setError("");
    try {
      await onSaveGroups(normalizeGroups(next));
      return true;
    } catch (nextError) {
      setError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function renameGroup(source: string, targetValue: string) {
    const target = targetValue.trim();
    if (
      groups.some(
        (group) =>
          group.toLowerCase() === target.toLowerCase() &&
          group.toLowerCase() !== source.toLowerCase(),
      )
    ) {
      setDialogError(t("host.groupNameDuplicate"));
      return;
    }
    setBusy(true);
    try {
      const affected = profiles.filter(
        (profile) => profile.tags?.[0]?.toLowerCase() === source.toLowerCase(),
      );
      await Promise.all(
        affected.map((profile) => onMoveProfileToGroup(profile.id, target)),
      );
      await onSaveGroups(
        normalizeGroups(
          groups.map((group) =>
            group.toLowerCase() === source.toLowerCase() ? target : group,
          ),
        ),
      );
      setGroupDialog(null);
      setDialogError(null);
    } catch (nextError) {
      setDialogError(
        nextError instanceof Error ? nextError.message : String(nextError),
      );
    } finally {
      setBusy(false);
    }
  }

  async function deleteGroup(group: string) {
    setBusy(true);
    try {
      const affected = profiles.filter(
        (profile) => profile.tags?.[0]?.toLowerCase() === group.toLowerCase(),
      );
      await Promise.all(
        affected.map((profile) => onMoveProfileToGroup(profile.id, null)),
      );
      await onSaveGroups(
        groups.filter((item) => item.toLowerCase() !== group.toLowerCase()),
      );
      setRemoveGroup(null);
    } finally {
      setBusy(false);
    }
  }

  function getGroupProfileCount(group: string) {
    return profiles.filter(
      (profile) =>
        profile.tags?.[0]?.trim().toLowerCase() === group.trim().toLowerCase(),
    ).length;
  }

  function profileMenu(profile: SerialProfile): ContextMenuItem[] {
    return [
      {
        label: t("rdp.actions.connect"),
        icon: <FiPlay />,
        disabled: connecting.has(profile.id),
        onClick: () => onConnect(profile),
      },
      {
        label: t("profile.menu.edit"),
        icon: <FiEdit2 />,
        onClick: () => onOpenEditProfile(profile),
      },
      {
        label: t("host.menu.moveTo"),
        icon: <FiFolder />,
        onClick: () => {
          setMoveProfile(profile);
          setMoveTarget(profile.tags?.[0] || ROOT_PROFILE_GROUP_VALUE);
        },
      },
      {
        label: t("profile.menu.delete"),
        icon: <FiTrash2 />,
        onClick: () => onRemoveProfile(profile),
      },
    ];
  }

  function renderProfile(profile: SerialProfile, nested = false) {
    return (
      <Button
        key={profile.id}
        className={`${nested ? "serial-profile-nested" : "serial-root-profile"}${
          activeProfileId === profile.id ? " active" : ""
        }`}
        variant="ghost"
        size="sm"
        onClick={() => onPick(profile.id)}
        onDoubleClick={() => !connecting.has(profile.id) && onConnect(profile)}
        onContextMenu={(event) => openMenu(event, profileMenu(profile))}
        data-ui="serial-profile-row"
      >
        <span className="serial-row-label">
          <FiCpu className="serial-row-icon" />
          <span>{profile.name || profile.portName}</span>
          {connecting.has(profile.id) ? (
            <span className="serial-connecting-chip">
              <FiLoader className="serial-spinning" />
              <span
                className="serial-connecting-cancel"
                role="button"
                aria-label={t("actions.cancel")}
                tabIndex={0}
                data-ui="serial-connect-cancel"
                onMouseDown={(event) => {
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.stopPropagation();
                  onCancelConnect(profile.id);
                }}
                onDoubleClick={(event) => {
                  event.stopPropagation();
                }}
                onKeyDown={(event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  event.stopPropagation();
                  onCancelConnect(profile.id);
                }}
              >
                <FiX />
              </span>
            </span>
          ) : null}
        </span>
      </Button>
    );
  }

  return (
    <section className="serial-widget" data-ui="serial-widget">
      <div className="serial-widget-toolbar">
        <input
          className="base-input serial-widget-search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("serial.search.placeholder")}
          data-slot="serial-search"
        />
      </div>
      <div
        className="serial-widget-list"
        onContextMenu={(event) =>
          openMenu(event, [
            {
              label: t("host.addGroup"),
              icon: <FiFolderPlus />,
              onClick: () => setGroupDialog({ mode: "add" }),
            },
            {
              label: t("serial.profile.new"),
              icon: <FiPlus />,
              onClick: () => onOpenNewProfile(),
            },
          ])
        }
      >
        {profiles.length
          ? filteredGroups.map((group) => {
              const expanded =
                normalizedQuery || expandedGroups.has(group.label);
              return (
                <div className="serial-group" key={group.label}>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="serial-group-title"
                    onClick={() =>
                      setExpandedGroups((current) => {
                        const next = new Set(current);
                        if (next.has(group.label)) {
                          next.delete(group.label);
                        } else {
                          next.add(group.label);
                        }
                        return next;
                      })
                    }
                    onContextMenu={(event) =>
                      openMenu(event, [
                        {
                          label: t("serial.profile.new"),
                          icon: <FiPlus />,
                          onClick: () => onOpenNewProfile(group.label),
                        },
                        {
                          label: t("host.menu.renameGroup"),
                          icon: <FiEdit2 />,
                          onClick: () =>
                            setGroupDialog({
                              mode: "rename",
                              source: group.label,
                            }),
                        },
                        {
                          label: t("host.menu.deleteGroup"),
                          icon: <FiTrash2 />,
                          onClick: () =>
                            getGroupProfileCount(group.label)
                              ? setRemoveGroup(group.label)
                              : void deleteGroup(group.label),
                        },
                      ])
                    }
                  >
                    <span className="serial-row-label">
                      <FiFolder className="serial-row-icon" />
                      <span>{group.label}</span>
                    </span>
                    <em>{group.profiles.length}</em>
                  </Button>
                  {expanded ? (
                    <div className="serial-group-list">
                      {group.profiles.map((profile) =>
                        renderProfile(profile, true),
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })
          : null}
        {rootProfiles.map((profile) => renderProfile(profile))}
        {!profiles.length ? (
          <div className="serial-widget-empty" data-ui="serial-widget-empty">
            {t("serial.profiles.empty")}
          </div>
        ) : null}
        {profiles.length && !filteredGroups.length && !rootProfiles.length ? (
          <div className="serial-widget-empty">{t("rdp.noMatch")}</div>
        ) : null}
        {error ? <div className="serial-widget-error">{error}</div> : null}
      </div>
      {menu ? <ContextMenu {...menu} onClose={() => setMenu(null)} /> : null}
      {groupDialog ? (
        <InputDialog
          open
          title={
            groupDialog.mode === "add"
              ? t("host.addGroup")
              : t("host.menu.renameGroup")
          }
          label={t("profile.form.group")}
          initialValue={groupDialog.source ?? ""}
          maxLength={GROUP_NAME_MAX_LENGTH}
          confirmText={t("actions.save")}
          cancelText={t("actions.cancel")}
          closeText={t("actions.close")}
          errorText={dialogError}
          onClose={() => setGroupDialog(null)}
          onValueChange={() => setDialogError(null)}
          onConfirm={(value) => {
            const target = value.trim();
            if (!target) {
              setDialogError(t("host.groupNameRequired"));
              return;
            }
            if (groupDialog.mode === "rename" && groupDialog.source) {
              void renameGroup(groupDialog.source, target);
              return;
            }
            if (
              groups.some(
                (group) => group.toLowerCase() === target.toLowerCase(),
              )
            ) {
              setDialogError(t("host.groupNameDuplicate"));
              return;
            }
            void persistGroups([...groups, target]).then(
              (ok) => ok && setGroupDialog(null),
            );
          }}
        />
      ) : null}
      {moveProfile ? (
        <Modal
          open
          busy={busy}
          title={t("host.moveDialogTitle")}
          closeLabel={t("actions.close")}
          onClose={() => setMoveProfile(null)}
          actions={
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setMoveProfile(null)}
              >
                {t("actions.cancel")}
              </Button>
              <Button
                size="sm"
                onClick={() =>
                  void onMoveProfileToGroup(
                    moveProfile.id,
                    moveTarget === ROOT_PROFILE_GROUP_VALUE ? null : moveTarget,
                  ).then(() => setMoveProfile(null))
                }
              >
                {t("actions.save")}
              </Button>
            </>
          }
        >
          <Select
            value={moveTarget}
            options={[
              { value: ROOT_PROFILE_GROUP_VALUE, label: t("host.ungrouped") },
              ...groupEntries.map((group) => ({
                value: group.label,
                label: group.label,
              })),
            ]}
            onChange={setMoveTarget}
          />
        </Modal>
      ) : null}
      {removeGroup ? (
        <Modal
          open
          busy={busy}
          title={t("host.deleteGroupTitle")}
          closeLabel={t("actions.close")}
          onClose={() => setRemoveGroup(null)}
          actions={
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setRemoveGroup(null)}
              >
                {t("actions.cancel")}
              </Button>
              <Button size="sm" onClick={() => void deleteGroup(removeGroup)}>
                {t("actions.remove")}
              </Button>
            </>
          }
        >
          <p>{t("host.deleteGroupConfirm", { name: removeGroup })}</p>
          <p>
            {t("host.deleteGroupHint", {
              target: t("host.ungrouped"),
              count: getGroupProfileCount(removeGroup),
            })}
          </p>
        </Modal>
      ) : null}
    </section>
  );
}
