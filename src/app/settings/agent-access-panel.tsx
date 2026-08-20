"use client";

import { Modal } from "@mantine/core";
import { CheckIcon, CopyIcon, PlugsConnectedIcon } from "@phosphor-icons/react";
import { useState, useTransition } from "react";

import { pauseAgentSkillsAction, revokeAgentConnectionAction } from "./actions";

type Connection = {
  id: string;
  clientName: string;
  clientDomain: string;
  scopes: string[];
  status: "ACTIVE" | "REVOKED";
  connectedAt: string;
  lastUsedAt: string | null;
  remoteRevocationStatus: string;
  operationCount: number;
};

type Activity = {
  id: string;
  clientName: string;
  status: string;
  requestedCount: number;
  activeCount: number;
  reusedCount: number;
  failedCount: number;
  updatedAt: string;
};

type Notice = {
  message: string;
  tone: "saved" | "error";
};

export function AgentAccessPanel({ resourceUrl, connections, activity }: {
  resourceUrl: string;
  connections: Connection[];
  activity: Activity[];
}) {
  const [copied, setCopied] = useState(false);
  const [selected, setSelected] = useState<Connection | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [pending, startTransition] = useTransition();

  function copyUrl() {
    startTransition(async () => {
      try {
        await navigator.clipboard.writeText(resourceUrl);
        setCopied(true);
        setNotice(null);
        window.setTimeout(() => setCopied(false), 1800);
      } catch {
        setNotice({ message: "The MCP address could not be copied. Select it and copy it manually.", tone: "error" });
      }
    });
  }

  function revoke() {
    if (!selected) return;
    startTransition(async () => {
      const result = await revokeAgentConnectionAction(selected.id);
      setNotice({ message: result.message, tone: result.status === "saved" ? "saved" : "error" });
      setSelected(null);
    });
  }

  function pause(connection: Connection) {
    startTransition(async () => {
      const result = await pauseAgentSkillsAction(connection.id);
      setNotice({ message: result.message, tone: result.status === "saved" ? "saved" : "error" });
    });
  }

  return (
    <section className="skillPanel settingsPanel agentAccessPanel" aria-labelledby="agent-access-title" id="agent-access">
      <div className="settingsSectionIntro">
        <h2 id="agent-access-title">AI agent access</h2>
        <p>Connect an agent once, then let it add verified skills to this account. Each connection can be revoked independently.</p>
      </div>

      <div className="agentMcpAddress">
        <div>
          <span>Remote MCP address</span>
          <code>{resourceUrl}</code>
        </div>
        <button className="secondaryButton" type="button" onClick={copyUrl} disabled={pending}>
          {copied ? <CheckIcon size={16} weight="bold" aria-hidden="true" /> : <CopyIcon size={16} weight="bold" aria-hidden="true" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>

      <p className="agentPermissionCopy">
        During connection, LearnRecur asks for only the permissions the agent requests: create and activate skills, read saved material outlines and excerpts, or prepare private source uploads. Disconnecting stops future calls and keeps existing skills.
      </p>

      <div className="agentAccessSubsection">
        <div className="agentAccessSubheading">
          <h3>Connections</h3>
          <span>{connections.filter((connection) => connection.status === "ACTIVE").length} active</span>
        </div>
        {connections.length === 0 ? (
          <div className="agentAccessEmpty">
            <PlugsConnectedIcon size={20} weight="bold" aria-hidden="true" />
            <p>No agents connected yet. Add the MCP address in your agent and sign in to LearnRecur when prompted.</p>
          </div>
        ) : (
          <div className="agentConnectionList">
            {connections.map((connection) => (
              <div className="agentConnectionRow" key={connection.id}>
                <div>
                  <strong>{connection.clientName}</strong>
                  <p>{connection.clientDomain} · {formatLastUsed(connection.lastUsedAt, connection.connectedAt)}</p>
                  <span>{permissionSummary(connection.scopes)}</span>
                </div>
                <div className="agentConnectionActions">
                  <span className="agentConnectionState">{connection.status === "ACTIVE" ? "Connected" : "Revoked"}</span>
                  {connection.status === "ACTIVE" ? (
                    <button className="textButton" type="button" onClick={() => setSelected(connection)}>Revoke</button>
                  ) : null}
                  <button className="textButton" type="button" onClick={() => pause(connection)} disabled={pending}>Pause its skills</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="agentAccessSubsection">
        <div className="agentAccessSubheading">
          <h3>Recent activity</h3>
        </div>
        {activity.length === 0 ? <p className="agentActivityEmpty">Agent-created skills will appear here.</p> : (
          <div className="agentActivityList">
            {activity.map((item) => (
              <div className="agentActivityRow" key={item.id}>
                <div><strong>{activityLabel(item)}</strong><span>{item.clientName}</span></div>
                <time dateTime={item.updatedAt}>{formatDate(item.updatedAt)}</time>
              </div>
            ))}
          </div>
        )}
      </div>

      {notice ? <p className="skillFormMessage" data-tone={notice.tone} role="status">{notice.message}</p> : null}

      <Modal
        opened={Boolean(selected)}
        onClose={() => setSelected(null)}
        title={selected ? `Revoke ${selected.clientName}?` : "Revoke connection?"}
        centered
        returnFocus
        classNames={{
          body: "skillGuidanceModalBody",
          content: "skillGuidanceModalContent",
          header: "skillGuidanceModalHeader",
          inner: "skillGuidanceModalInner",
          overlay: "skillGuidanceModalOverlay",
          root: "skillGuidanceModalRoot",
          title: "skillGuidanceModalTitle",
        }}
      >
        <p className="agentRevokeCopy">Future calls from this connection will stop immediately. Skills it already added will remain active unless you pause them separately.</p>
        <div className="agentRevokeActions">
          <button className="secondaryButton" type="button" onClick={() => setSelected(null)}>Keep connected</button>
          <button className="dangerButton" type="button" onClick={revoke} disabled={pending}>{pending ? "Revoking…" : "Revoke connection"}</button>
        </div>
      </Modal>
    </section>
  );
}

function permissionSummary(scopes: string[]) {
  const labels = scopes.flatMap((scope) => scope === "skills:create" ? ["add skills"] : scope === "materials:read" ? ["read materials"] : scope === "sources:upload" ? ["upload sources"] : []);
  return labels.length ? labels.join(" · ") : "No active permissions";
}

function formatLastUsed(lastUsedAt: string | null, connectedAt: string) {
  return lastUsedAt ? `Used ${formatDate(lastUsedAt)}` : `Connected ${formatDate(connectedAt)}`;
}

function formatDate(value: string) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: new Date(value).getFullYear() === new Date().getFullYear() ? undefined : "numeric" }).format(new Date(value));
}

function activityLabel(item: Activity) {
  if (item.status === "SUCCEEDED") return `${item.activeCount} active · ${item.reusedCount} reused`;
  if (item.status === "FAILED") return `${item.failedCount || item.requestedCount} failed`;
  if (item.status === "NEEDS_REVIEW") return "Needs review";
  return item.status.toLocaleLowerCase("en-US").replaceAll("_", " ");
}
