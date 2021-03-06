import childProcess from "child-process-es6-promise"
import util, { ScriptError, StatementBase } from "../utility"

export const capabilities = [
  "cap_audit_control",
  "cap_audit_write",
  "cap_block_suspend",
  "cap_chown",
  "cap_dac_override",
  "cap_dac_read_search",
  "cap_fowner",
  "cap_fsetid",
  "cap_ipc_lock",
  "cap_ipc_owner",
  "cap_kill",
  "cap_lease",
  "cap_linux_immutable",
  "cap_mac_admin",
  "cap_mac_override",
  "cap_mknod",
  "cap_net_admin",
  "cap_net_bind_service",
  "cap_net_broadcast",
  "cap_net_raw",
  "cap_setgid",
  "cap_setfcap",
  "cap_setpcap",
  "cap_setuid",
  "cap_sys_admin",
  "cap_sys_boot",
  "cap_sys_chroot",
  "cap_sys_module",
  "cap_sys_nice",
  "cap_sys_pacct",
  "cap_sys_ptrace",
  "cap_sys_rawio",
  "cap_sys_resource",
  "cap_sys_time",
  "cap_sys_tty_config",
  "cap_syslog",
  "cap_wake_alarm",
]

const getFlagsString = (effective, permitted, inheritable) =>
  (effective ? "e" : "") + (permitted ? "p" : "") + (inheritable ? "i" : "")

export class FileHasCapability extends StatementBase {
  constructor(container) {
    super(container.interpolator)

    this.util = container.util || util
    this.childProcess = container.childProcess || childProcess
    this.stat = null
  }

  async assert(assertNode) {
    const { fileNode, capabilityNode, flagsNode } = this.parseWithArgsNode(
      assertNode,
      [
        { name: "file", type: "string", as: "filePath" },
        { name: "capability", type: "string" },
        { name: "flags", type: "string" },
      ]
    )

    this.capability = this.capability.toLowerCase()

    if (!capabilities.includes(this.capability)) {
      throw new ScriptError(
        `Invalid capability ${this.capability}`,
        capabilityNode
      )
    }

    if (
      this.flags.length !== 3 ||
      !(
        (this.flags[0] === "e" || this.flags[0] === "-") &&
        (this.flags[1] === "p" || this.flags[1] === "-") &&
        (this.flags[2] === "i" || this.flags[2] === "-")
      )
    ) {
      throw new ScriptError(
        "'flags' must be formatted as 3 character string with 'epi' to set corresponding flag, or hyphen if flag not set",
        flagsNode
      )
    }

    this.effective = this.flags[0] === "e" ? true : false
    this.permitted = this.flags[1] === "p" ? true : false
    this.inheritable = this.flags[2] === "i" ? true : false

    const pathInfo = await this.util.pathInfo(this.filePath)

    if (pathInfo.isMissing()) {
      throw new ScriptError(`File '${this.filePath}' does not exist`, fileNode)
    }

    if (!pathInfo.isFile()) {
      throw new ScriptError(`'${this.filePath}' is not a file`, fileNode)
    }

    if (!this.util.runningAsRoot()) {
      throw new ScriptError(
        "Must be running as root to view or modify file capabilities",
        assertNode
      )
    }

    const command = `setcap -v ${this.capability}=${getFlagsString(
      this.effective,
      this.permitted,
      this.inheritable
    )} ${this.filePath}`

    try {
      await this.childProcess.exec(command)
    } catch {
      return false
    }

    return true
  }

  async rectify() {
    const command = `setcap ${this.capability}=${getFlagsString(
      this.effective,
      this.permitted,
      this.inheritable
    )} ${this.filePath}`

    await this.childProcess.exec(command)
  }

  result() {
    return {
      file: this.filePath,
      capability: this.capability,
      flags: this.flags,
    }
  }
}
