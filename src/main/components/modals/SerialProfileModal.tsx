/** 串口 Profile 编辑弹窗。 */
import { useMemo, useState } from "react";
import Button from "@/components/ui/button";
import Modal from "@/components/ui/modal/Modal";
import Select from "@/components/ui/select";
import { ROOT_PROFILE_GROUP_VALUE } from "@/constants/hostGroups";
import { cloneSerialProfile } from "@/features/serial/core/defaults";
import type { Translate } from "@/i18n";
import { translateAppError } from "@/shared/errors/appError";
import type { SerialPortInfo, SerialProfile } from "@/types";
import "@/main/components/modals/SerialProfileModal.css";

const COMMON_BAUD_RATES = [
  300, 600, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, 115200, 230400,
  460800, 921600,
];
const CUSTOM_BAUD_VALUE = "custom";

type SerialProfileModalProps = {
  open: boolean;
  initialProfile: SerialProfile;
  ports: SerialPortInfo[];
  groups: string[];
  onClose: () => void;
  onSave: (profile: SerialProfile) => Promise<void>;
  t: Translate;
};

/** 编辑并校验串口会话与协议参数。 */
export default function SerialProfileModal({
  open,
  initialProfile,
  ports,
  groups,
  onClose,
  onSave,
  t,
}: SerialProfileModalProps) {
  const [draft, setDraft] = useState(() => cloneSerialProfile(initialProfile));
  const [section, setSection] = useState<"session" | "protocol">("session");
  const [customBaud, setCustomBaud] = useState(
    !COMMON_BAUD_RATES.includes(initialProfile.baudRate),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const portOptions = useMemo(() => {
    const available = ports.map((port) => ({
      value: port.portName,
      label: `${port.portName}${
        port.product || port.manufacturer
          ? ` · ${port.product || port.manufacturer}`
          : ""
      }`,
    }));
    if (
      draft.portName &&
      !ports.some((port) => port.portName === draft.portName)
    ) {
      available.unshift({
        value: draft.portName,
        label: `${draft.portName} · ${t("serial.profile.portUnavailable")}`,
      });
    }
    return available;
  }, [draft.portName, ports, t]);
  const groupOptions = [
    { value: ROOT_PROFILE_GROUP_VALUE, label: t("host.ungrouped") },
    ...groups.map((group) => ({ value: group, label: group })),
  ];

  async function submit() {
    if (!draft.name.trim() || !draft.portName.trim()) {
      setError(t("serial.profile.required"));
      setSection("session");
      return;
    }
    if (!Number.isInteger(draft.baudRate) || draft.baudRate <= 0) {
      setError(t("serial.profile.invalidBaud"));
      setSection("protocol");
      return;
    }
    setBusy(true);
    setError("");
    try {
      await onSave({
        ...draft,
        name: draft.name.trim(),
        portName: draft.portName.trim(),
      });
      onClose();
    } catch (nextError) {
      setError(translateAppError(nextError, t));
    } finally {
      setBusy(false);
    }
  }

  const field = (label: string, control: React.ReactNode, wide = false) => (
    <div
      className={`serial-profile-field${wide ? " serial-profile-wide" : ""}`}
    >
      <span>{label}</span>
      {control}
    </div>
  );

  return (
    <Modal
      open={open}
      busy={busy}
      title={t("serial.profile.modalTitle")}
      closeLabel={t("actions.close")}
      onClose={onClose}
      bodyClassName="serial-profile-modal-body"
      actions={
        <>
          <Button variant="ghost" size="sm" onClick={onClose}>
            {t("actions.cancel")}
          </Button>
          <Button size="sm" onClick={() => void submit()} disabled={busy}>
            {t("actions.save")}
          </Button>
        </>
      }
    >
      <div className="serial-profile-layout" data-ui="serial-profile-form">
        <nav className="serial-profile-nav" data-slot="serial-profile-nav">
          {(["session", "protocol"] as const).map((item) => (
            <button
              key={item}
              type="button"
              className={section === item ? "active" : ""}
              onClick={() => setSection(item)}
            >
              {t(`serial.profile.section.${item}`)}
            </button>
          ))}
        </nav>
        <section className="serial-profile-content">
          <div className="serial-profile-grid">
            {section === "session" ? (
              <>
                {field(
                  t("serial.profile.name"),
                  <input
                    value={draft.name}
                    onChange={(event) =>
                      setDraft((current) => ({
                        ...current,
                        name: event.target.value,
                      }))
                    }
                  />,
                )}
                {field(
                  t("profile.form.group"),
                  <Select
                    value={draft.tags?.[0] || ROOT_PROFILE_GROUP_VALUE}
                    options={groupOptions}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        tags:
                          value === ROOT_PROFILE_GROUP_VALUE ? null : [value],
                      }))
                    }
                  />,
                )}
                {field(
                  t("serial.profile.port"),
                  <Select
                    value={draft.portName}
                    options={portOptions}
                    placeholder={t("serial.profile.selectPort")}
                    onChange={(value) =>
                      setDraft((current) => ({ ...current, portName: value }))
                    }
                  />,
                  true,
                )}
                {field(
                  t("serial.profile.encoding"),
                  <Select
                    value={draft.encoding}
                    options={[
                      { value: "utf8", label: "UTF-8" },
                      { value: "gb18030", label: "GB18030" },
                    ]}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        encoding: value as SerialProfile["encoding"],
                      }))
                    }
                  />,
                )}
                {field(
                  t("serial.profile.lineEnding"),
                  <Select
                    value={draft.lineEnding}
                    options={["none", "cr", "lf", "crlf"].map((value) => ({
                      value,
                      label: t(
                        `serial.lineEnding.${value}` as "serial.lineEnding.none",
                      ),
                    }))}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        lineEnding: value as SerialProfile["lineEnding"],
                      }))
                    }
                  />,
                )}
              </>
            ) : (
              <>
                {field(
                  t("serial.profile.baudRate"),
                  <div
                    className={`serial-profile-baud${customBaud ? " custom" : ""}`}
                  >
                    <Select
                      value={
                        customBaud ? CUSTOM_BAUD_VALUE : String(draft.baudRate)
                      }
                      options={[
                        ...COMMON_BAUD_RATES.map((value) => ({
                          value: String(value),
                          label: String(value),
                        })),
                        {
                          value: CUSTOM_BAUD_VALUE,
                          label: t("serial.profile.customBaud"),
                        },
                      ]}
                      onChange={(value) => {
                        const custom = value === CUSTOM_BAUD_VALUE;
                        setCustomBaud(custom);
                        if (!custom) {
                          setDraft((current) => ({
                            ...current,
                            baudRate: Number(value),
                          }));
                        }
                      }}
                    />
                    {customBaud ? (
                      <input
                        type="number"
                        min={1}
                        value={draft.baudRate || ""}
                        onChange={(event) =>
                          setDraft((current) => ({
                            ...current,
                            baudRate: Number(event.target.value),
                          }))
                        }
                      />
                    ) : null}
                  </div>,
                  true,
                )}
                {field(
                  t("serial.profile.dataBits"),
                  <Select
                    value={draft.dataBits}
                    options={["five", "six", "seven", "eight"].map(
                      (value, index) => ({
                        value,
                        label: String(index + 5),
                      }),
                    )}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        dataBits: value as SerialProfile["dataBits"],
                      }))
                    }
                  />,
                )}
                {field(
                  t("serial.profile.stopBits"),
                  <Select
                    value={draft.stopBits}
                    options={[
                      { value: "one", label: "1" },
                      { value: "two", label: "2" },
                    ]}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        stopBits: value as SerialProfile["stopBits"],
                      }))
                    }
                  />,
                )}
                {field(
                  t("serial.profile.parity"),
                  <Select
                    value={draft.parity}
                    options={["none", "even", "odd"].map((value) => ({
                      value,
                      label: t(
                        `serial.parity.${value}` as "serial.parity.none",
                      ),
                    }))}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        parity: value as SerialProfile["parity"],
                      }))
                    }
                  />,
                )}
                {field(
                  t("serial.profile.flowControl"),
                  <Select
                    value={draft.flowControl}
                    options={["none", "software", "hardware"].map((value) => ({
                      value,
                      label: t(
                        `serial.flowControl.${value}` as "serial.flowControl.none",
                      ),
                    }))}
                    onChange={(value) =>
                      setDraft((current) => ({
                        ...current,
                        flowControl: value as SerialProfile["flowControl"],
                      }))
                    }
                  />,
                )}
              </>
            )}
          </div>
          {error ? <p className="serial-profile-error">{error}</p> : null}
        </section>
      </div>
    </Modal>
  );
}
