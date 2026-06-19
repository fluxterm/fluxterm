/**
 * SSH 主机列表行。
 * 统一封装分组内与根级主机的选中、右键菜单、连接和连接取消交互。
 */
import { createElement } from "react";
import { FiLoader, FiX } from "react-icons/fi";
import Button from "@/components/ui/button";
import { resolveProfileIcon } from "@/features/profile/profileIcons";
import type { Translate } from "@/i18n";
import type { HostProfile, SshConnectStateMap } from "@/types";
import { resolveHostProfileDisplayName } from "@/widgets/profiles/components/hostWidgetModel";

type HostProfileRowProps = {
  profile: HostProfile;
  active: boolean;
  root?: boolean;
  sshConnectingProfiles: SshConnectStateMap;
  onOpenMenu: (
    event: {
      preventDefault: () => void;
      stopPropagation: () => void;
      clientX: number;
      clientY: number;
    },
    profile: HostProfile,
  ) => void;
  onPick: (id: string) => void;
  onConnectProfile: (profile: HostProfile) => void;
  onCancelSshConnectProfile: (profileId: string) => void;
  t: Translate;
};

/** 渲染单个 SSH 主机条目。 */
export default function HostProfileRow({
  profile,
  active,
  root = false,
  sshConnectingProfiles,
  onOpenMenu,
  onPick,
  onConnectProfile,
  onCancelSshConnectProfile,
  t,
}: HostProfileRowProps) {
  const className = root
    ? `host-root-profile${active ? " active" : ""}`
    : active
      ? "active"
      : undefined;

  return (
    <Button
      className={className}
      variant="ghost"
      size="sm"
      data-ui="host-profile-row"
      data-slot={root ? "root-profile" : "group-profile"}
      onContextMenu={(event) => onOpenMenu(event, profile)}
      onClick={() => onPick(profile.id)}
      onDoubleClick={() => {
        if (sshConnectingProfiles[profile.id]) return;
        onConnectProfile(profile);
      }}
    >
      <span className="host-row-label">
        {createElement(resolveProfileIcon(profile.iconKey), {
          className: "host-row-icon",
        })}
        <span>{resolveHostProfileDisplayName(profile)}</span>
        {sshConnectingProfiles[profile.id] ? (
          <span className="host-connecting-chip">
            <FiLoader className="host-connecting-icon" />
            <span
              className="host-connecting-cancel"
              role="button"
              aria-label={t("actions.cancel")}
              title={t("actions.cancel")}
              tabIndex={0}
              onMouseDown={(event) => {
                event.stopPropagation();
              }}
              onClick={(event) => {
                event.stopPropagation();
                onCancelSshConnectProfile(profile.id);
              }}
              onKeyDown={(event) => {
                if (event.key !== "Enter" && event.key !== " ") return;
                event.preventDefault();
                event.stopPropagation();
                onCancelSshConnectProfile(profile.id);
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
